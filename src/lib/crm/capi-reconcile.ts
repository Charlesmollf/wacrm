import type { SupabaseClient } from '@supabase/supabase-js'
import { reportPurchaseForDeal } from '@/lib/meta/report-purchase'

// ============================================================
// Red de seguridad: concilia ventas pagadas contra lo que Meta
// realmente recibió.
//
// Toda venta confirmada debería quedar con `capi_sent_at`. Si por lo
// que sea (red caída, timeout, la función se congeló antes de terminar,
// un fallo puntual de Meta) el envío no cerró, el deal queda con
// `capi_sent_at = null` y este barrido lo reenvía.
//
// Meta deduplica por `event_id = deal_<id>`, así que reenviar es
// seguro: nunca cuenta la misma compra dos veces.
//
// Ventana de 7 días porque la Conversions API rechaza eventos más
// viejos que eso.
// ============================================================

const LOOKBACK_DAYS = 7
const MAX_ATTEMPTS = 6
const MAX_PER_RUN = 40

export interface ReconcileResult {
  checked: number
  resent: number
  failed: number
}

export async function reconcileCapiPurchases(
  db: SupabaseClient,
): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, resent: 0, failed: 0 }
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

    // Ventas pagadas recientes que nunca cerraron su envío a Meta.
    const { data: pending, error } = await db
      .from('deals')
      .select('id, account_id, value, currency, contact_id, conversation_id, capi_attempts, sold_at, updated_at')
      .eq('payment_status', 'Pagado')
      .is('capi_sent_at', null)
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(MAX_PER_RUN)

    if (error) {
      console.error('[capi-reconcile] query failed:', error.message)
      return out
    }
    if (!pending || pending.length === 0) return out

    for (const d of pending) {
      out.checked++
      // No insistir para siempre en un deal que siempre falla.
      if (((d.capi_attempts as number | null) ?? 0) >= MAX_ATTEMPTS) continue
      // La CAPI rechaza eventos de más de 7 días: si la venta ya es más
      // vieja que la ventana, no tiene caso reintentar.
      const saleIso = (d.sold_at as string | null) ?? (d.updated_at as string | null)
      if (saleIso && new Date(saleIso).getTime() < Date.now() - LOOKBACK_DAYS * 86_400_000) {
        continue
      }

      const r = await reportPurchaseForDeal(db, d.account_id as string, {
        id: d.id as string,
        value: d.value as number | string | null,
        currency: d.currency as string | null,
        contact_id: (d.contact_id as string | null) ?? null,
        conversation_id: (d.conversation_id as string | null) ?? null,
      })
      if (r.sent) out.resent++
      else out.failed++
    }
  } catch (err) {
    console.error('[capi-reconcile] failed:', err)
  }
  return out
}
