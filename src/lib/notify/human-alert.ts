import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Emails the shop owner when a customer writes on a conversation the AI
 * is NOT handling — because it was manually paused ("AI assistant is
 * paused here") or handed off to / assigned to a human. Lets the owner
 * jump straight to the thread instead of watching the inbox.
 *
 * DEBOUNCE (one email per unanswered burst) is decided by the CALLER
 * using the conversation's own timestamps: it only calls this on the
 * FIRST customer message since the last outbound reply. So a customer
 * firing 25 messages in a row produces ONE email; once the owner
 * replies (last_outbound_at moves past last_inbound_at) the next burst
 * alerts again. No extra column or state is needed.
 *
 * Best-effort: every error is swallowed so it can never affect the
 * webhook's 200 to Meta.
 */
export async function notifyHumanNeeded(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId?: string | null
    preview?: string | null
  },
): Promise<void> {
  try {
    const { accountId, conversationId, contactId } = args

    const { data: config } = await db
      .from('whatsapp_config')
      .select('resend_api_key, alert_email')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config?.resend_api_key || !config?.alert_email) return

    let apiKey: string
    try {
      apiKey = decrypt(config.resend_api_key)
    } catch {
      return
    }

    let contactName = 'Un cliente'
    let contactPhone = ''
    if (contactId) {
      const { data: contact } = await db
        .from('contacts')
        .select('name, phone')
        .eq('id', contactId)
        .maybeSingle()
      if (contact?.name) contactName = contact.name
      if (contact?.phone) contactPhone = contact.phone
    }

    const preview = (args.preview ?? '').trim().slice(0, 160)
    const link = `https://aqua-gaur-598822.hostingersite.com/inbox?c=${conversationId}`
    const subject = `🔔 ${contactName} está esperando respuesta (IA en pausa)`
    const html =
      `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#111">` +
      `<h2 style="margin:0 0 8px">💬 Un cliente necesita tu atención</h2>` +
      `<p style="margin:0 0 4px">La IA está en pausa en esta conversación y el cliente escribió.</p>` +
      `<p style="margin:0 0 4px"><b>Cliente:</b> ${contactName}` +
      (contactPhone ? ` · ${contactPhone}` : '') +
      `</p>` +
      (preview
        ? `<p style="margin:8px 0;padding:8px 12px;background:#f3f4f6;border-radius:8px;color:#374151">"${preview}"</p>`
        : '') +
      `<p style="margin:12px 0"><a href="${link}" ` +
      `style="background:#16a34a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">` +
      `Abrir la conversación</a></p>` +
      `<p style="margin:12px 0 0;font-size:12px;color:#6b7280">Recibirás UN solo aviso por conversación hasta que le respondas; luego, si vuelve a escribir, te avisamos de nuevo.</p>` +
      `</div>`

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Kaffeejager CRM <onboarding@resend.dev>',
        to: [config.alert_email],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    console.error('[human-alert] notify failed:', err)
  }
}
