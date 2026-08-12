import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Manda un pedido confirmado a la Google Sheet "Pedidos de Cafe Yaguer".
 *
 * Antes, al confirmar un pago el CRM solo generaba un resumen para copiar
 * y pegar a mano en el WhatsApp de la tostaduria. Ahora el pedido entra
 * solo a la hoja, en la fila de hasta arriba.
 *
 * Corre en el SERVIDOR (Hostinger), no en el navegador: funciona aunque
 * la computadora del duenio este apagada.
 *
 * Del otro lado hay un Apps Script publicado como app web, protegido por
 * un secreto compartido. Todo es best-effort: si Google no responde, el
 * pago igual queda confirmado — nunca se arruina la operacion por un
 * problema de una hoja de calculo.
 */

export interface OrderForSheet {
  id: string
  value: number | string | null
  payment_method: string | null
  grind: string | null
  address: string | null
  nit: string | null
  notes: string | null
  combo_history: string | null
  sold_at: string | null
  updated_at: string | null
  contact_id: string | null
}

/** Productos del pedido ACTUAL: todas las lineas con la fecha mas reciente. */
function productoActual(historial: string | null | undefined): string {
  const lineas = String(historial ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lineas.length === 0) return ''
  const fechaDe = (l: string) => l.match(/^\[([^\]]*)\]/)?.[1] ?? ''
  const ultima = fechaDe(lineas[lineas.length - 1])
  const delDia = ultima ? lineas.filter((l) => fechaDe(l) === ultima) : [lineas[lineas.length - 1]]
  const items = Array.from(
    new Set(delDia.map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean)),
  )
  return items.join(' + ')
}

/** dd/mm/aaaa en hora de Guatemala (UTC-6), como lo lee la tostaduria. */
function fechaGT(iso: string | null | undefined): string {
  const base = iso ? new Date(iso) : new Date()
  const gt = new Date(base.getTime() - 6 * 3600000)
  const dd = String(gt.getUTCDate()).padStart(2, '0')
  const mm = String(gt.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${gt.getUTCFullYear()}`
}

export async function pushOrderToSheet(
  db: SupabaseClient,
  accountId: string,
  deal: OrderForSheet,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { data: cfg } = await db
      .from('whatsapp_config')
      .select('sheets_webhook_url, sheets_webhook_token')
      .eq('account_id', accountId)
      .maybeSingle()

    const url = cfg?.sheets_webhook_url as string | undefined
    const token = cfg?.sheets_webhook_token as string | undefined
    if (!url || !token) return { ok: false, reason: 'hoja no configurada' }

    let cliente = ''
    let telefono = ''
    let correo = ''
    if (deal.contact_id) {
      const { data: c } = await db
        .from('contacts')
        .select('name, phone, email')
        .eq('id', deal.contact_id)
        .maybeSingle()
      cliente = String(c?.name ?? '')
      telefono = String(c?.phone ?? '')
      correo = String(c?.email ?? '')
    }

    const cuerpo = {
      token,
      deal_id: deal.id,
      // Se manda la fecha de la VENTA (no la de confirmacion): asi lo
      // pidio el duenio y asi quedaron los 85 pedidos historicos.
      fecha: fechaGT(deal.sold_at ?? deal.updated_at),
      cliente,
      telefono,
      producto: productoActual(deal.combo_history),
      molienda: deal.grind ?? '',
      total: Number(deal.value) || '',
      pago: deal.payment_method ?? '',
      direccion: deal.address ?? '',
      nit: deal.nit ?? '',
      correo,
      notas: deal.notes ?? '',
    }

    // Apps Script responde con un 302 hacia googleusercontent; fetch lo
    // sigue solo. 15 s de techo para no colgar la confirmacion del pago.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })

    const texto = await res.text().catch(() => '')
    if (!res.ok) {
      console.error('[sheets] la hoja rechazo el pedido', res.status, texto.slice(0, 300))
      return { ok: false, reason: `http ${res.status}` }
    }
    let json: { ok?: boolean; error?: string; duplicado?: boolean } | null = null
    try {
      json = JSON.parse(texto)
    } catch {
      // Apps Script devuelve HTML de login si la app web quedo publicada
      // como privada: eso es configuracion, no un error de red.
      console.error(
        '[sheets] respuesta inesperada (revisar el acceso del Apps Script):',
        texto.slice(0, 200),
      )
      return { ok: false, reason: 'respuesta no JSON' }
    }
    if (!json?.ok) {
      console.error('[sheets] el script devolvio error:', json?.error)
      return { ok: false, reason: json?.error ?? 'error del script' }
    }
    console.log(`[sheets] pedido ${deal.id} agregado${json.duplicado ? ' (ya estaba)' : ''}`)
    return { ok: true }
  } catch (err) {
    console.error('[sheets] no se pudo agregar el pedido:', err)
    return { ok: false, reason: err instanceof Error ? err.message : 'excepcion' }
  }
}
