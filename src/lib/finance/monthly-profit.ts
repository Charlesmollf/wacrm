// ===========================================================================
// GANANCIA POR MES
//
// Recalcula `monthly_profit` a partir de los deals Pagados: la venta es el
// `value` real de cada deal (lo que de verdad entro), y el costo se estima
// con `margenDelDeal` (ver margenes.ts) aplicado en PROPORCION sobre ese
// mismo `value` — no se usa el total del catalogo directo, porque puede
// no calzar exacto con lo que quedo guardado (descuentos, ajustes a mano).
//
// Deals sin carrito reconocible (no se pudo leer ni el carrito guardado ni
// el texto de combo_history) usan el margen promedio de respaldo en vez de
// quedar fuera del calculo.
// ===========================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { margenDelDeal, MARGEN_PROMEDIO_RESPALDO, COSTOS_FIJOS_POR_PEDIDO } from './margenes'

export interface MesGanancia {
  accountId: string
  month: string // 'YYYY-MM-01'
  ventas: number
  costos: number
  ganancia: number
  pedidos: number
  pedidosSinDesglose: number
}

/** YYYY-MM-01 en hora de Guatemala (UTC-6), igual que el resto del dashboard. */
function primerDiaDelMesGT(iso: string): string {
  const gt = new Date(new Date(iso).getTime() - 6 * 3600000)
  const y = gt.getUTCFullYear()
  const m = String(gt.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

interface DealRow {
  account_id: string
  value: number | string | null
  sold_at: string | null
  updated_at: string | null
  combo_history: string | null
  carrito: unknown
}

/** Agrupa deals Pagados por cuenta+mes y calcula venta/costo/ganancia de cada uno. */
export function calcularGananciaPorMes(deals: DealRow[]): MesGanancia[] {
  const porMes = new Map<string, MesGanancia>()

  for (const d of deals) {
    const fecha = d.sold_at ?? d.updated_at
    if (!fecha || !d.account_id) continue
    const mes = primerDiaDelMesGT(fecha)
    const clave = `${d.account_id}|${mes}`
    const venta = Number(d.value) || 0

    const margen = margenDelDeal(d)
    let costo: number
    let sinDesglose = false
    if (margen && margen.ventaCatalogo > 0) {
      // Costo proporcional: la MISMA razon costo/venta del catalogo,
      // aplicada sobre el valor real del deal.
      costo = venta * (margen.costoCatalogo / margen.ventaCatalogo)
    } else {
      costo = venta * (1 - MARGEN_PROMEDIO_RESPALDO)
      sinDesglose = true
    }
    // Costos fijos por pedido que la hoja de "Costos Combos" NO incluye en
    // el margen (guia CAEX, caja, hoja de lino, papel kraft, bono de
    // empaque) — ver detalle en margenes.ts.
    costo += COSTOS_FIJOS_POR_PEDIDO

    const actual = porMes.get(clave) ?? {
      accountId: d.account_id,
      month: mes,
      ventas: 0,
      costos: 0,
      ganancia: 0,
      pedidos: 0,
      pedidosSinDesglose: 0,
    }
    actual.ventas += venta
    actual.costos += costo
    actual.pedidos += 1
    if (sinDesglose) actual.pedidosSinDesglose += 1
    porMes.set(clave, actual)
  }

  for (const m of porMes.values()) {
    m.ventas = Math.round(m.ventas * 100) / 100
    m.costos = Math.round(m.costos * 100) / 100
    m.ganancia = Math.round((m.ventas - m.costos) * 100) / 100
  }

  return [...porMes.values()].sort(
    (a, b) => a.month.localeCompare(b.month) || a.accountId.localeCompare(b.accountId),
  )
}

/**
 * Recalcula y guarda `monthly_profit` para TODOS los meses con ventas
 * Pagadas, de todas las cuentas. Reemplaza filas existentes (upsert por
 * cuenta+mes) — mismo patron que `avisarGuiasPendientes`/
 * `reconcileCapiPurchases`: corre global, sin pedir accountId.
 */
export async function recalcularGananciaMensual(
  db: SupabaseClient,
): Promise<{ ok: true; meses: MesGanancia[] } | { ok: false; error: string }> {
  const { data, error } = await db
    .from('deals')
    .select('account_id, value, sold_at, updated_at, combo_history, carrito')
    .eq('payment_status', 'Pagado')
    .limit(20000)

  if (error) return { ok: false, error: error.message }

  const meses = calcularGananciaPorMes((data ?? []) as DealRow[])

  // Gastos generales del mes que no dependen del pedido (publicidad,
  // contador, Shopify, herramientas de IA, cuota fija de pasarela) —
  // se cargan a mano cada mes en `monthly_overhead` (ver Settings >
  // Finanzas). Un mes sin fila ahi se calcula sin overhead, no se bloquea.
  const { data: overheads } = await db
    .from('monthly_overhead')
    .select('account_id, month, contador, publicidad, shopify, api_ia, pasarela_fija, otros')
  const overheadPorClave = new Map<string, number>()
  for (const o of (overheads ?? []) as Record<string, unknown>[]) {
    const clave = `${o.account_id}|${o.month}`
    const total =
      (Number(o.contador) || 0) +
      (Number(o.publicidad) || 0) +
      (Number(o.shopify) || 0) +
      (Number(o.api_ia) || 0) +
      (Number(o.pasarela_fija) || 0) +
      (Number(o.otros) || 0)
    overheadPorClave.set(clave, total)
  }
  for (const m of meses) {
    const overhead = overheadPorClave.get(`${m.accountId}|${m.month}`) ?? 0
    if (overhead > 0) {
      m.costos = Math.round((m.costos + overhead) * 100) / 100
      m.ganancia = Math.round((m.ventas - m.costos) * 100) / 100
    }
  }

  const filas = meses.map((m) => ({
    account_id: m.accountId,
    month: m.month,
    ventas: m.ventas,
    costos: m.costos,
    ganancia: m.ganancia,
    pedidos: m.pedidos,
    pedidos_sin_desglose: m.pedidosSinDesglose,
    computed_at: new Date().toISOString(),
  }))

  if (filas.length > 0) {
    const { error: errUpsert } = await db
      .from('monthly_profit')
      .upsert(filas, { onConflict: 'account_id,month' })
    if (errUpsert) return { ok: false, error: errUpsert.message }
  }

  return { ok: true, meses }
}
