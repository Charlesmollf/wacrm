// ===========================================================================
// PEDIDOS DE SHOPIFY -> CRM
//
// Hasta ahora las ventas de la tienda vivian solo en Shopify: no habia
// contacto, no habia tarjeta y no llegaban a la hoja de la tostaduria. Habia
// que copiarlas a mano.
//
// Aca traducimos un pedido de Shopify al lenguaje del CRM y lo dejamos en la
// cola de "Confirmar pagos", igual que un pedido de WhatsApp. El duenio lo
// revisa, aprieta el boton, y de ahi sale a la hoja por el camino de siempre.
//
// Sirve tanto para los pagados con tarjeta como para los de contra entrega:
// en los dos casos hay algo que revisar antes de mandarlo a preparar.
// ===========================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact } from '@/lib/contacts/dedupe'

/** Lo que nos interesa de un pedido de Shopify. */
export interface ShopifyOrder {
  id: number | string
  name?: string | null
  email?: string | null
  note?: string | null
  total_price?: string | number | null
  financial_status?: string | null
  gateway?: string | null
  payment_gateway_names?: string[] | null
  phone?: string | null
  customer?: { first_name?: string | null; last_name?: string | null; phone?: string | null } | null
  shipping_address?: {
    name?: string | null
    phone?: string | null
    address1?: string | null
    address2?: string | null
    city?: string | null
    province?: string | null
  } | null
  billing_address?: { phone?: string | null } | null
  line_items?: Array<{
    title?: string | null
    quantity?: number | null
    variant_title?: string | null
  }> | null
}

export interface ResultadoIngreso {
  ok: boolean
  motivo?: string
  dealId?: string
  contactId?: string
  duplicado?: boolean
}

/**
 * Telefono de Guatemala en el formato del CRM: 502 + 8 digitos.
 *
 * Shopify los guarda como se le antoje al cliente: unos escriben
 * "+502 4194 0733" y otros solo "41940733". Sin normalizar, el mismo
 * cliente entraba dos veces y nunca calzaba con su chat de WhatsApp.
 */
export function normalizarTelefono(crudo: string | null | undefined): string {
  const soloDigitos = String(crudo ?? '').replace(/\D/g, '')
  if (!soloDigitos) return ''
  if (soloDigitos.length === 8) return `502${soloDigitos}`
  if (soloDigitos.length === 11 && soloDigitos.startsWith('502')) return soloDigitos
  // Numeros de otro pais o algo raro: se devuelven tal cual y que decida
  // quien llama. Nunca inventamos un prefijo que no vimos.
  return soloDigitos
}

/**
 * Molienda y accesorio salen juntos en la variante, separados por " / ":
 *   "Grano / Cafetera Italiana (Moka)"  ->  Grano  +  Cafetera Italiana (Moka)
 *   "Molido / Sin Articulo"             ->  Molido +  (nada)
 */
export function partirVariante(variante: string | null | undefined): {
  molienda: string
  accesorio: string
} {
  const partes = String(variante ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
  const molienda = partes[0] ?? ''
  const accesorio = partes[1] ?? ''
  const sinAccesorio = /sin\s*art[ií]culo|ninguno|none/i.test(accesorio)
  return {
    molienda: /molid/i.test(molienda) ? 'Molido' : /gran/i.test(molienda) ? 'Grano' : molienda,
    accesorio: sinAccesorio ? '' : accesorio,
  }
}

/** Como le decimos en la hoja a la forma de pago que reporta Shopify. */
export function traducirFormaDePago(pedido: ShopifyOrder): string {
  const pasarelas = (pedido.payment_gateway_names ?? [])
    .concat(pedido.gateway ? [pedido.gateway] : [])
    .join(' ')
    .toLowerCase()
  if (/cash on delivery|contra\s*entrega|\bcod\b/.test(pasarelas)) return 'Contra entrega'
  if (/transfer|dep[oó]sito/.test(pasarelas)) return 'Transferencia'
  // Cybersource y cualquier otra pasarela de tarjeta: el cliente ya pago
  // en linea, que es lo mismo que un link de pago para la tostaduria.
  return 'Link de pago'
}

/** Producto legible: junta todas las lineas del pedido con su accesorio. */
export function armarProducto(pedido: ShopifyOrder): { producto: string; molienda: string } {
  const lineas = pedido.line_items ?? []
  const nombres: string[] = []
  const moliendas = new Set<string>()
  for (const l of lineas) {
    const { molienda, accesorio } = partirVariante(l.variant_title)
    if (molienda) moliendas.add(molienda)
    const cantidad = Number(l.quantity ?? 1)
    const base = String(l.title ?? '').trim()
    if (!base) continue
    const conCantidad = cantidad > 1 ? `${cantidad} ${base}` : base
    nombres.push(accesorio ? `${conCantidad} + ${accesorio}` : conCantidad)
  }
  return {
    producto: nombres.join(' + '),
    // Si el pedido lleva unos en grano y otros molidos, es Mixto: la
    // tostaduria necesita verlo de un vistazo para no equivocarse.
    molienda: moliendas.size > 1 ? 'Mixto' : [...moliendas][0] ?? '',
  }
}

/** Direccion en una sola linea, como la escribe la gente. */
export function armarDireccion(pedido: ShopifyOrder): string {
  const d = pedido.shipping_address
  if (!d) return ''
  return [d.address2, d.address1, d.city, d.province]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .join(', ')
}

/** Nombre del cliente, prefiriendo el de la guia de envio. */
export function armarNombre(pedido: ShopifyOrder): string {
  const envio = String(pedido.shipping_address?.name ?? '').trim()
  if (envio) return envio
  const c = pedido.customer
  return [c?.first_name, c?.last_name].map((p) => String(p ?? '').trim()).filter(Boolean).join(' ')
}

/** El telefono puede venir en tres lugares distintos; se toma el primero. */
export function armarTelefono(pedido: ShopifyOrder): string {
  for (const candidato of [
    pedido.shipping_address?.phone,
    pedido.billing_address?.phone,
    pedido.customer?.phone,
    pedido.phone,
  ]) {
    const t = normalizarTelefono(candidato)
    if (t) return t
  }
  return ''
}

/**
 * Mete el pedido en el CRM. Best-effort y idempotente: si el mismo pedido
 * llega dos veces (Shopify reintenta hasta recibir un 200), la segunda no
 * duplica nada.
 */
export async function ingresarPedidoDeShopify(
  db: SupabaseClient,
  accountId: string,
  pedido: ShopifyOrder,
): Promise<ResultadoIngreso> {
  try {
    const referencia = `shopify:${pedido.id}`

    // 1. ¿Ya lo tenemos? La referencia queda escrita en las notas del deal.
    const { data: yaEsta } = await db
      .from('deals')
      .select('id')
      .eq('account_id', accountId)
      .ilike('notes', `%${referencia}%`)
      .limit(1)
      .maybeSingle()
    if (yaEsta) {
      return { ok: true, duplicado: true, dealId: (yaEsta as { id: string }).id }
    }

    const telefono = armarTelefono(pedido)
    const nombre = armarNombre(pedido)
    const { producto, molienda } = armarProducto(pedido)
    const direccion = armarDireccion(pedido)
    const formaDePago = traducirFormaDePago(pedido)
    const total = Number(String(pedido.total_price ?? '0').replace(/[^0-9.]/g, ''))
    const correo = String(pedido.email ?? '').trim() || null

    if (!telefono) {
      // Sin telefono no hay a quien escribirle ni con quien emparejar.
      // Se rechaza a proposito para que quede en los logs y se revise a
      // mano, en vez de crear un contacto fantasma.
      return { ok: false, motivo: 'el pedido no trae telefono' }
    }

    // 2. El dueno de la cuenta, para el campo de auditoria de las filas.
    const { data: cfg } = await db
      .from('whatsapp_config')
      .select('user_id')
      .eq('account_id', accountId)
      .maybeSingle()
    const ownerUserId = (cfg as { user_id?: string } | null)?.user_id ?? null

    // 3. Contacto: si ya compro por WhatsApp, se reusa el suyo.
    let contactId: string
    const existente = await findExistingContact(db, accountId, telefono)
    if (existente) {
      contactId = existente.id
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      // El correo de Shopify es un dato duro que el chat casi nunca tiene.
      if (correo && !existente.email) patch.email = correo
      await db.from('contacts').update(patch).eq('id', contactId)
    } else {
      const { data: nuevo, error } = await db
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: ownerUserId,
          phone: telefono,
          name: nombre || telefono,
          email: correo,
        })
        .select('id')
        .single()
      if (error || !nuevo) {
        return { ok: false, motivo: 'no se pudo crear el contacto: ' + (error?.message ?? '') }
      }
      contactId = (nuevo as { id: string }).id
    }

    // 4. La tarjeta va a "Pedidos Confirmados", que es de donde sale la
    //    cola de Confirmar pagos.
    const { data: pipelines } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1)
    const pipelineId = (pipelines ?? [])[0]?.id as string | undefined

    let stageId: string | null = null
    if (pipelineId) {
      const { data: etapa } = await db
        .from('pipeline_stages')
        .select('id')
        .eq('pipeline_id', pipelineId)
        .eq('name', 'Pedidos Confirmados')
        .maybeSingle()
      stageId = (etapa as { id: string } | null)?.id ?? null
    }

    const hoy = new Date().toISOString().slice(0, 10)
    const notas = [
      `${referencia} (${pedido.name ?? ''})`.trim(),
      String(pedido.note ?? '').trim(),
    ]
      .filter(Boolean)
      .join(' · ')

    const { data: deal, error: errDeal } = await db
      .from('deals')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        contact_id: contactId,
        pipeline_id: pipelineId ?? null,
        stage_id: stageId,
        stage_entered_at: new Date().toISOString(),
        title: nombre || telefono,
        value: Number.isFinite(total) && total > 0 ? String(total) : '0',
        currency: 'GTQ',
        status: 'open',
        payment_status: 'Por confirmar',
        payment_method: formaDePago,
        grind: molienda || null,
        address: direccion || null,
        notes: notas,
        combo_history: producto ? `[${hoy}] ${producto}` : null,
        sold_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (errDeal || !deal) {
      return { ok: false, motivo: 'no se pudo crear el pedido: ' + (errDeal?.message ?? '') }
    }

    console.log(
      `[shopify] pedido ${pedido.name ?? pedido.id} de ${nombre} (${telefono}) entro a Confirmar pagos por Q${total}`,
    )
    return { ok: true, dealId: (deal as { id: string }).id, contactId }
  } catch (err) {
    return {
      ok: false,
      motivo: err instanceof Error ? err.message : 'error inesperado',
    }
  }
}
