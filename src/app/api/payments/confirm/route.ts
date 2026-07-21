import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendPurchaseEvent } from '@/lib/meta/capi'
import { syncPaymentTag } from '@/lib/crm/payment-tags'

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
      .select('id, value, currency, contact_id, conversation_id, pipeline_id')
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
    const capi = await reportPurchaseToMeta(accountId, deal)

    return NextResponse.json({ ok: true, capi })
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

async function reportPurchaseToMeta(
  accountId: string,
  deal: {
    id: string
    value: number | null
    currency: string | null
    contact_id: string | null
    conversation_id: string | null
  },
): Promise<{ sent: boolean; reason?: string; attributed?: boolean; error?: string }> {
  try {
    const db = supabaseAdmin()

    const { data: config } = await db
      .from('whatsapp_config')
      .select('capi_dataset_id, capi_access_token, access_token, waba_id')
      .eq('account_id', accountId)
      .maybeSingle()

    const datasetId = config?.capi_dataset_id
    if (!config || !datasetId) {
      return { sent: false, reason: 'capi_not_configured' }
    }

    let accessToken: string
    try {
      accessToken = config.capi_access_token
        ? decrypt(config.capi_access_token)
        : decrypt(config.access_token)
    } catch {
      return { sent: false, reason: 'token_decrypt_failed' }
    }

    // Prefer a conversation that actually carries an ad click id; fall back
    // to the deal's own conversation.
    let ctwaClid: string | null = null
    if (deal.contact_id) {
      const { data: conv } = await db
        .from('conversations')
        .select('ctwa_clid')
        .eq('contact_id', deal.contact_id)
        .not('ctwa_clid', 'is', null)
        .order('ctwa_captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      ctwaClid = conv?.ctwa_clid ?? null
    }

    let phone: string | null = null
    let email: string | null = null
    let firstName: string | null = null
    let lastName: string | null = null
    if (deal.contact_id) {
      const { data: contact } = await db
        .from('contacts')
        .select('phone_normalized, phone, email, name')
        .eq('id', deal.contact_id)
        .maybeSingle()
      phone = contact?.phone_normalized ?? contact?.phone ?? null
      email = (contact as { email?: string | null } | null)?.email ?? null
      const nameParts = (contact?.name ?? '').trim().split(/\s+/)
      if (nameParts.length > 0 && nameParts[0]) firstName = nameParts[0]
      if (nameParts.length > 1) lastName = nameParts[nameParts.length - 1]
    }

    // With a ctwa_clid this is a deterministic CTWA conversion; without
    // one we still send it — advanced matching (hashed phone/name/email)
    // lets Meta credit the campaign when this buyer saw or clicked an ad.
    const result = await sendPurchaseEvent({
      datasetId,
      accessToken,
      value: Number(deal.value) || 0,
      currency: deal.currency || 'GTQ',
      phone,
      email,
      firstName,
      lastName,
      ctwaClid,
      eventId: `deal_${deal.id}`,
      wabaId: config.waba_id ?? null,
    })

    if (!result.ok) {
      console.error('[payments/confirm] CAPI purchase failed:', result.error)
      return { sent: false, reason: 'capi_error', error: result.error }
    }
    return { sent: true, attributed: result.attributed }
  } catch (err) {
    console.error('[payments/confirm] reportPurchaseToMeta failed:', err)
    return { sent: false, reason: 'exception' }
  }
}
