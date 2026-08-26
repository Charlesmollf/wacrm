// ===========================================================================
// AVISO DE SHOPIFY: entro un pedido.
//
// Shopify llama aca cada vez que alguien compra en la tienda. Verificamos que
// el aviso venga de verdad de Shopify (viene firmado), resolvemos a que cuenta
// pertenece la tienda, y metemos el pedido al CRM.
//
// Siempre contestamos 200, incluso si algo sale mal de nuestro lado: si
// devolvemos error, Shopify reintenta el mismo pedido durante dos dias y
// termina desactivando el webhook. Los problemas se ven en los logs.
// ===========================================================================

import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { ingresarPedidoDeShopify, type ShopifyOrder } from '@/lib/shopify/order-intake'

export const maxDuration = 30

/**
 * Compara la firma que manda Shopify con la que calculamos nosotros.
 * Se usa comparacion de tiempo constante: comparar con === deja filtrar el
 * secreto midiendo cuanto tarda en fallar.
 */
function firmaValida(cuerpo: string, firmaRecibida: string, secreto: string): boolean {
  try {
    const propia = crypto.createHmac('sha256', secreto).update(cuerpo, 'utf8').digest('base64')
    const a = Buffer.from(propia)
    const b = Buffer.from(firmaRecibida)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  try {
    const cuerpo = await request.text()
    const dominio = request.headers.get('x-shopify-shop-domain') ?? ''
    const firma = request.headers.get('x-shopify-hmac-sha256') ?? ''
    const tema = request.headers.get('x-shopify-topic') ?? ''

    if (!dominio) {
      console.warn('[shopify] aviso sin dominio de tienda, se ignora')
      return NextResponse.json({ ok: true, ignorado: 'sin dominio' })
    }

    const db = supabaseAdmin()
    const { data: cfg } = await db
      .from('whatsapp_config')
      .select('account_id, shopify_webhook_secret')
      .eq('shopify_domain', dominio)
      .maybeSingle()

    if (!cfg) {
      console.warn(`[shopify] tienda desconocida: ${dominio}`)
      return NextResponse.json({ ok: true, ignorado: 'tienda no configurada' })
    }

    // La firma es lo unico que separa un pedido real de cualquiera que
    // adivine la direccion. Sin secreto guardado no se procesa nada.
    // La clave puede vivir en dos lados. Se prefiere la de la base (por si
    // algun dia hay varias tiendas), pero lo normal es tenerla como variable
    // de entorno en el servidor: asi la pega el duenio directo en Hostinger y
    // no pasa por ningun lado mas.
    const guardado = (cfg as { shopify_webhook_secret?: string | null }).shopify_webhook_secret
    let secreto = ''
    if (guardado) {
      try {
        secreto = decrypt(guardado)
      } catch {
        console.error('[shopify] no se pudo descifrar la clave guardada')
      }
    }
    if (!secreto) secreto = process.env.SHOPIFY_WEBHOOK_SECRET ?? ''
    if (!secreto) {
      console.error(`[shopify] falta la clave de firma para ${dominio}`)
      return NextResponse.json({ ok: true, ignorado: 'sin clave de firma' })
    }
    if (!firmaValida(cuerpo, firma, secreto)) {
      console.warn(`[shopify] firma invalida desde ${dominio}`)
      return NextResponse.json({ ok: false, error: 'firma invalida' }, { status: 401 })
    }

    if (!/^orders\/(create|paid)$/.test(tema)) {
      return NextResponse.json({ ok: true, ignorado: `tema ${tema}` })
    }

    const pedido = JSON.parse(cuerpo) as ShopifyOrder
    const accountId = (cfg as { account_id: string }).account_id
    const r = await ingresarPedidoDeShopify(db, accountId, pedido)

    if (!r.ok) {
      console.error(`[shopify] pedido ${pedido.name ?? pedido.id} no entro: ${r.motivo}`)
    }
    return NextResponse.json({ recibido: true, ...r })
  } catch (err) {
    console.error('[shopify] fallo procesando el aviso:', err)
    return NextResponse.json({ ok: true, error: 'procesado con errores' })
  }
}
