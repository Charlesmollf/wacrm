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
      await sendScheduled(admin, b as ScheduledRow)
      await admin
        .from('broadcasts')
        .update({ dispatch_status: 'done', status: 'sent' })
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

async function sendScheduled(
  admin: SupabaseClient,
  b: ScheduledRow,
): Promise<void> {
  const payload = b.send_payload
  if (!payload?.recipients?.length || !payload.template_name) return

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

  for (const recipient of payload.recipients) {
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
  }
}
