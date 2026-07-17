import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Emails the shop owner the instant a deal lands in the "Confirmar pagos"
 * queue (payment_status → "Por confirmar"), so they can jump to the CRM and
 * confirm it. Sent via Resend using the account's stored API key. Best-effort:
 * every error is swallowed so it can never block the deal update.
 */
export async function notifyPaymentToConfirm(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId?: string | null
    value?: number | string | null
    paymentMethod?: string | null
  },
): Promise<void> {
  try {
    const { accountId, contactId } = args

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

    let contactName = 'un cliente'
    if (contactId) {
      const { data: contact } = await db
        .from('contacts')
        .select('name')
        .eq('id', contactId)
        .maybeSingle()
      if (contact?.name) contactName = contact.name
    }

    const amount = args.value ? `Q${String(args.value).replace(/[^0-9.]/g, '')}` : ''
    const method = args.paymentMethod ? ` · ${args.paymentMethod}` : ''
    const subject = `⚠️ Pago por confirmar: ${contactName}${amount ? ` (${amount})` : ''}`
    const html =
      `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#111">` +
      `<h2 style="margin:0 0 8px">☕ Nuevo pago por confirmar</h2>` +
      `<p style="margin:0 0 4px"><b>Cliente:</b> ${contactName}</p>` +
      (amount ? `<p style="margin:0 0 4px"><b>Monto:</b> ${amount}${method}</p>` : '') +
      `<p style="margin:12px 0 4px">Entra a <b>Confirmar pagos</b> en el CRM, verifica el pago y márcalo como Pagado.</p>` +
      `<p style="margin:12px 0"><a href="https://aqua-gaur-598822.hostingersite.com/payments" ` +
      `style="background:#16a34a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">` +
      `Abrir Confirmar pagos</a></p>` +
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
    console.error('[payment-alert] notify failed:', err)
  }
}
