import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { reportPurchaseForDeal } from '@/lib/meta/report-purchase'
import { syncPaymentTag } from '@/lib/crm/payment-tags'
import { pushOrderToSheet } from '@/lib/sheets/push-order'

/**
 * POST /api/payments/confirm  (agent+)
 *
 * Body: { deal_id }
 *
 * Marks a deal's payment as "Pagado" and — this is the whole point of doing
 * it server-side — fires a Purchase event back to Meta's Conversions API so
 * the ad campaigns learn which chats became real, paid sales and optimize
 * toward them. Sales with a CTWA click id go out as business_messaging
 * (deterministic attribution); everything else goes out as an advanced-
 * matching website event (hashed phone/name/email) so purchases from
 * people who saw the ad but bought through an old chat still credit the
 * campaign. The Meta call is best-effort: it never blocks or fails the
 * payment confirmation.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const body = await request.json().catch(() => null)
    const dealId =
      body && typeof body.deal_id === 'string' ? body.deal_id : ''
    if (!dealId) {
      return NextResponse.json({ error: 'deal_id is required' }, { status: 400 })
    }

    // RLS scopes this to the caller's account — a missing row is "not yours".
    const { data: deal, error: dealErr } = await supabase
      .from('deals')
      .select(
        'id, value, currency, contact_id, conversation_id, pipeline_id, payment_method, grind, address, nit, notes, combo_history, sold_at, updated_at',
      )
      .eq('id', dealId)
      .maybeSingle()
    if (dealErr) {
      return NextResponse.json({ error: 'Failed to load deal' }, { status: 500 })
    }
    if (!deal) {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 })
    }

    const { error: updErr } = await supabase
      .from('deals')
      .update({ payment_status: 'Pagado' })
      .eq('id', dealId)
    if (updErr) {
      return NextResponse.json(
        { error: 'No se pudo confirmar el pago: ' + updErr.message },
        { status: 500 },
      )
    }

    // The confirm button is the manual gate that releases the order to
    // the roastery — reflect that on the board: the card moves itself
    // from "Pedidos Confirmados" to "Enviado". From there the cron
    // promotes it to "Ganados" after 5 business days.
    try {
      const admin = supabaseAdmin()
      const pipelineId = (deal as { pipeline_id?: string | null }).pipeline_id
      if (pipelineId) {
        const { data: enviado } = await admin
          .from('pipeline_stages')
          .select('id')
          .eq('pipeline_id', pipelineId)
          .eq('name', 'Enviado')
          .maybeSingle()
        if (enviado) {
          await admin
            .from('deals')
            .update({
              stage_id: enviado.id,
              stage_entered_at: new Date().toISOString(),
            })
            .eq('id', dealId)
        }
      }
    } catch (moveErr) {
      console.error('[payments/confirm] move to Enviado failed:', moveErr)
    }

    // Move the contact's payment tag to "Pagado" so filters stay accurate.
    if (deal.contact_id) {
      void syncPaymentTag(supabaseAdmin(), {
        accountId,
        contactId: deal.contact_id,
        paymentStatus: 'Pagado',
      })
    }

    // Fire the Meta Purchase signal (best-effort, service-role reads).
    // The shared helper retries transient failures and records the
    // outcome on the deal, so a purchase that still doesn't make it is
    // picked up automatically by the daily reconciler.
    const capi = await reportPurchaseForDeal(supabaseAdmin(), accountId, deal)

    // Y a la hoja de la tostaduria. Corre en el servidor, asi que el
    // pedido aparece aunque la computadora del duenio este apagada.
    // Best-effort: un fallo aqui no invalida el pago ya confirmado.
    const hoja = await pushOrderToSheet(supabaseAdmin(), accountId, {
      id: deal.id,
      value: deal.value,
      payment_method: (deal as { payment_method?: string | null }).payment_method ?? null,
      grind: (deal as { grind?: string | null }).grind ?? null,
      address: (deal as { address?: string | null }).address ?? null,
      nit: (deal as { nit?: string | null }).nit ?? null,
      notes: (deal as { notes?: string | null }).notes ?? null,
      combo_history: (deal as { combo_history?: string | null }).combo_history ?? null,
      sold_at: (deal as { sold_at?: string | null }).sold_at ?? null,
      updated_at: (deal as { updated_at?: string | null }).updated_at ?? null,
      contact_id: deal.contact_id,
    })

    return NextResponse.json({ ok: true, capi, hoja })
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status?: number }).status ?? 500
        : 500
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status },
    )
  }
}
