import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendPurchaseEvent } from '@/lib/meta/capi'

/**
 * Reporta una venta confirmada a Meta y DEJA CONSTANCIA en el deal
 * (`capi_status` / `capi_sent_at` / `capi_error` / `capi_attempts`).
 *
 * Es la única ruta de envío: la usa el botón "Confirmar pago" y también
 * el reconciliador diario. Gracias a la bitácora, una compra que falla
 * (red caída, timeout, Meta de mal humor) ya NO se pierde en silencio —
 * queda marcada como pendiente y se reintenta sola.
 *
 * `event_id = deal_<id>` hace que Meta deduplique: reenviar la misma
 * venta nunca la cuenta dos veces.
 */
export interface DealForCapi {
  id: string
  value: number | string | null
  currency: string | null
  contact_id: string | null
  conversation_id?: string | null
}

export interface ReportResult {
  sent: boolean
  reason?: string
  attributed?: boolean
  error?: string
}

export async function reportPurchaseForDeal(
  db: SupabaseClient,
  accountId: string,
  deal: DealForCapi,
): Promise<ReportResult> {
  let result: ReportResult
  try {
    const { data: config } = await db
      .from('whatsapp_config')
      .select('capi_dataset_id, capi_access_token, access_token, waba_id')
      .eq('account_id', accountId)
      .maybeSingle()

    const datasetId = config?.capi_dataset_id
    if (!config || !datasetId) {
      result = { sent: false, reason: 'capi_not_configured' }
      await stamp(db, deal.id, 'skipped', result.reason)
      return result
    }

    let accessToken: string
    try {
      accessToken = config.capi_access_token
        ? decrypt(config.capi_access_token)
        : decrypt(config.access_token)
    } catch {
      result = { sent: false, reason: 'token_decrypt_failed' }
      await stamp(db, deal.id, 'failed', result.reason)
      return result
    }

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
      const parts = (contact?.name ?? '').trim().split(/\s+/)
      if (parts.length > 0 && parts[0]) firstName = parts[0]
      if (parts.length > 1) lastName = parts[parts.length - 1]
    }

    const r = await sendPurchaseEvent({
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

    if (!r.ok) {
      console.error('[capi] purchase failed for deal', deal.id, r.error)
      result = { sent: false, reason: 'capi_error', error: r.error }
      await stamp(db, deal.id, 'failed', r.error ?? 'capi_error')
      return result
    }

    result = { sent: true, attributed: r.attributed }
    await stamp(db, deal.id, 'sent', null)
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[capi] reportPurchaseForDeal threw:', msg)
    await stamp(db, deal.id, 'failed', msg).catch(() => {})
    return { sent: false, reason: 'exception', error: msg }
  }
}

/** Escribe el resultado del intento en el deal (best-effort). */
async function stamp(
  db: SupabaseClient,
  dealId: string,
  status: 'sent' | 'failed' | 'skipped',
  error: string | null,
): Promise<void> {
  try {
    const { data: row } = await db
      .from('deals')
      .select('capi_attempts')
      .eq('id', dealId)
      .maybeSingle()
    const attempts = ((row?.capi_attempts as number | null) ?? 0) + 1
    const patch: Record<string, unknown> = {
      capi_status: status,
      capi_error: error ? String(error).slice(0, 500) : null,
      capi_attempts: attempts,
    }
    // Solo un envío aceptado (o deliberadamente omitido) cierra el caso;
    // un fallo deja `capi_sent_at` en null para que el reconciliador lo
    // vuelva a tomar.
    if (status === 'sent' || status === 'skipped') {
      patch.capi_sent_at = new Date().toISOString()
    }
    await db.from('deals').update(patch).eq('id', dealId)
  } catch (e) {
    console.error('[capi] stamp failed:', e)
  }
}
