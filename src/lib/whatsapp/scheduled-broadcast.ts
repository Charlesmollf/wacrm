import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplateMessage } from './meta-api'
import { decrypt } from './encryption'
import { isMessageTemplate } from './template-row-guard'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from './phone-utils'
import type { SendTimeParams } from './template-send-builder'

interface SchedRecipient {
  contact_id?: string | null
  phone: string
  params?: string[]
  messageParams?: SendTimeParams
}
interface SendPayload {
  template_name: string
  template_language?: string
  recipients: SchedRecipient[]
}

/**
 * Server-side scheduled broadcasts. A broadcast row with
 * dispatch_status='scheduled' and scheduled_at <= now is picked up here
 * (called from the automations cron, which runs every ~5 min) and sent —
 * no browser/session needed. Claims via a status flip so overlapping cron
 * runs never double-send. Best-effort: errors are logged, never thrown to
 * the caller.
 */
export async function drainScheduledBroadcasts(
  admin: SupabaseClient,
): Promise<number> {
  const now = new Date().toISOString()
  const { data: due, error } = await admin
    .from('broadcasts')
    .select('id, account_id, user_id, send_payload')
    .eq('dispatch_status', 'scheduled')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(3)
  if (error || !due || due.length === 0) return 0

  let processed = 0
  for (const b of due) {
    // Claim: only one runner flips scheduled → sending.
    const { data: claim } = await admin
      .from('broadcasts')
      .update({ dispatch_status: 'sending' })
      .eq('id', b.id)
      .eq('dispatch_status', 'scheduled')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      const { finished } = await sendScheduled(admin, b as ScheduledRow)
      await admin
        .from('broadcasts')
        .update(
          finished
            ? { dispatch_status: 'done', status: 'sent' }
            : // Quedan destinatarios: se devuelve a la cola para que la
              // siguiente corrida del cron continúe donde quedó.
              { dispatch_status: 'scheduled', status: 'sending' },
        )
        .eq('id', b.id)
    } catch (err) {
      console.error('[scheduled-broadcast] failed for', b.id, err)
      await admin
        .from('broadcasts')
        .update({ dispatch_status: 'failed', status: 'failed' })
        .eq('id', b.id)
    }
    processed++
  }
  return processed
}

interface ScheduledRow {
  id: string
  account_id: string
  user_id: string
  send_payload: SendPayload
}

// Una difusión grande NO cabe en una sola ejecución: mandar ~1000
// plantillas de corrido tarda más que el tiempo máximo de la petición y
// el proceso muere a media lista (fue justo lo que pasó con la difusión
// de 349). Por eso cada corrida envía un LOTE acotado — por cantidad y
// por tiempo — registra a quién ya le llegó, y devuelve la difusión a la
// cola para que la siguiente corrida siga donde quedó.
const BATCH_MAX_RECIPIENTS = 120
const BATCH_MAX_MS = 40_000
const PAUSE_BETWEEN_SENDS_MS = 150

async function sendScheduled(
  admin: SupabaseClient,
  b: ScheduledRow,
): Promise<{ finished: boolean }> {
  const payload = b.send_payload
  if (!payload?.recipients?.length || !payload.template_name) {
    return { finished: true }
  }

  const { data: config } = await admin
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', b.account_id)
    .single()
  if (!config) throw new Error('whatsapp_config missing')
  const accessToken = decrypt(config.access_token)

  const { data: rawTemplateRow } = await admin
    .from('message_templates')
    .select('*')
    .eq('account_id', b.account_id)
    .eq('name', payload.template_name)
    .eq('language', payload.template_language || 'en_US')
    .maybeSingle()
  const templateRow =
    rawTemplateRow && isMessageTemplate(rawTemplateRow) ? rawTemplateRow : null

  // A quién ya se le procesó en corridas anteriores (evita duplicados al
  // reanudar).
  const alreadyDone = new Set<string>()
  {
    let from = 0
    while (true) {
      const { data: rows } = await admin
        .from('broadcast_recipients')
        .select('contact_id')
        .eq('broadcast_id', b.id)
        .range(from, from + 999)
      if (!rows || rows.length === 0) break
      for (const r of rows) if (r.contact_id) alreadyDone.add(r.contact_id as string)
      if (rows.length < 1000) break
      from += 1000
    }
  }

  const pending = payload.recipients.filter(
    (r) => !r.contact_id || !alreadyDone.has(r.contact_id),
  )
  if (pending.length === 0) return { finished: true }

  const startedAt = Date.now()
  let processedNow = 0

  for (const recipient of pending) {
    if (
      processedNow >= BATCH_MAX_RECIPIENTS ||
      Date.now() - startedAt > BATCH_MAX_MS
    ) {
      break
    }
    const sanitized = sanitizePhoneForMeta(recipient.phone)
    let status: 'sent' | 'failed' = 'failed'
    let wamid: string | null = null
    let errMsg: string | null = null

    if (!isValidE164(sanitized)) {
      errMsg = 'Invalid phone number format'
    } else {
      for (const variant of phoneVariants(sanitized)) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: payload.template_name,
            language: payload.template_language || 'en_US',
            template: templateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
          wamid = result.messageId
          status = 'sent'
          errMsg = null
          break
        } catch (e) {
          errMsg = e instanceof Error ? e.message : 'Unknown error'
          if (!isRecipientNotAllowedError(errMsg)) break
        }
      }
    }

    await admin.from('broadcast_recipients').insert({
      broadcast_id: b.id,
      contact_id: recipient.contact_id ?? null,
      status,
      whatsapp_message_id: wamid,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
      error_message: errMsg,
    })
    processedNow++
    if (PAUSE_BETWEEN_SENDS_MS > 0) {
      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_SENDS_MS))
    }
  }

  return { finished: processedNow >= pending.length }
}
