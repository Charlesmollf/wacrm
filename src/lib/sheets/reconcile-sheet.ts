import type { SupabaseClient } from '@supabase/supabase-js'
import { pushOrderToSheet } from '@/lib/sheets/push-order'

/**
 * Reintenta los pedidos Pagados que no llegaron a la hoja de la tostaduria.
 * El script deduplica por deal_id, asi que reintentar nunca duplica filas.
 * Ventana de 14 dias y 5 por corrida para no saturar el tick.
 */
export async function reconcileSheetPushes(
  db: SupabaseClient,
): Promise<{ intentados: number; ok: number }> {
  const desde = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data } = await db
    .from('deals')
    .select(
      'id, account_id, value, payment_method, grind, address, nit, notes, combo_history, sold_at, updated_at, contact_id',
    )
    .eq('payment_status', 'Pagado')
    .is('sheet_pushed_at', null)
    .gte('sold_at', desde)
    .order('sold_at', { ascending: true })
    .limit(5)
  let ok = 0
  const filas = data ?? []
  for (const d of filas) {
    const r = await pushOrderToSheet(db, d.account_id as string, {
      id: d.id as string,
      value: d.value as number | string | null,
      payment_method: (d.payment_method as string | null) ?? null,
      grind: (d.grind as string | null) ?? null,
      address: (d.address as string | null) ?? null,
      nit: (d.nit as string | null) ?? null,
      notes: (d.notes as string | null) ?? null,
      combo_history: (d.combo_history as string | null) ?? null,
      sold_at: (d.sold_at as string | null) ?? null,
      updated_at: (d.updated_at as string | null) ?? null,
      contact_id: (d.contact_id as string | null) ?? null,
    })
    if (r.ok) ok++
  }
  return { intentados: filas.length, ok }
}
