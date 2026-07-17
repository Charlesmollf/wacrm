import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/whatsapp/capi/test  (admin+)
 *
 * Sends a test payment-alert email via Resend using the saved key, and
 * returns the raw Resend result — including any error — so the owner can
 * confirm the alert works (or see exactly why it doesn't).
 */
export async function POST() {
  try {
    const { accountId } = await requireRole('admin')

    const { data: config } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('resend_api_key, alert_email')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config?.alert_email) {
      return NextResponse.json(
        { ok: false, error: 'Falta el correo de alerta. Guárdalo primero.' },
        { status: 400 },
      )
    }
    if (!config?.resend_api_key) {
      return NextResponse.json(
        { ok: false, error: 'Falta la API key de Resend. Guárdala primero.' },
        { status: 400 },
      )
    }

    let apiKey: string
    try {
      apiKey = decrypt(config.resend_api_key)
    } catch {
      return NextResponse.json(
        { ok: false, error: 'No se pudo descifrar la API key de Resend.' },
        { status: 500 },
      )
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Kaffeejager CRM <onboarding@resend.dev>',
        to: [config.alert_email],
        subject: '✅ Prueba — alerta de pagos wacrm',
        html:
          '<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#111">' +
          '<h2 style="margin:0 0 8px">✅ ¡La alerta funciona!</h2>' +
          '<p>Este es un correo de prueba. Cuando un pedido entre a ' +
          '<b>Confirmar pagos</b>, te llegará un aviso igual que este con el ' +
          'cliente y el monto.</p></div>',
      }),
      signal: AbortSignal.timeout(10000),
    })

    const body = (await res.json().catch(() => null)) as {
      id?: string
      message?: string
      name?: string
    } | null

    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        status: res.status,
        to: config.alert_email,
        error: body?.message ?? body?.name ?? `HTTP ${res.status}`,
      })
    }
    return NextResponse.json({ ok: true, to: config.alert_email, id: body?.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
