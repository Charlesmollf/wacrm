// ============================================================
// Extract structured lead data from an AI reply and write it to the
// contact's deal card.
//
// The agent is instructed (see DEAL_EXTRACTION_INSTRUCTIONS) to append a
// single invisible marker to its reply whenever it learns a concrete
// fact about the order:
//
//   [[SET: forma_pago=Transferencia; estado_pago=Pagado; molienda=Grano;
//          combo=Bourbon; direccion=3a calle 8-45 zona 3; nit=1234567]]
//
// `extractDealMarkers` pulls that out (returning the cleaned text so the
// marker never reaches the customer) and `applyDealUpdates` writes the
// values onto the most recent deal for the contact. Combos are APPENDED
// to combo_history so we keep the full purchase history over time.
//
// Everything here is best-effort and never throws — a bad marker must
// never break the customer-facing reply or the webhook's 200 to Meta.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyPaymentToConfirm } from '@/lib/notify/payment-alert'
import { syncPaymentTag } from '@/lib/crm/payment-tags'

/** Instruction block injected into the auto-reply system prompt so the
 *  model knows to emit the marker. Spanish, matching the Kaffeejager
 *  agent's voice. Kept here so the prompt and the parser stay in sync. */
export const DEAL_EXTRACTION_INSTRUCTIONS =
  'EXTRACCION DE DATOS (INVISIBLE): Cuando en la conversacion el cliente indique o tu confirmes cualquiera de estos datos, agrega al FINAL del mensaje UNA sola marca con este formato EXACTO: ' +
  '[[SET: forma_pago=...; estado_pago=...; molienda=...; combo=...; direccion=...; nit=...]]. ' +
  'Incluye SOLO las claves que conozcas con certeza y omite las demas. ' +
  'Valores permitidos: forma_pago = Link de pago | Transferencia | Contra entrega; estado_pago = Pendiente | Por confirmar (nunca pongas Pagado; SOLO el equipo lo marca a mano); molienda = Grano | Molido | Mixto (usa Mixto SOLO cuando en un mismo pedido unos productos van en grano y otros molidos; en ese caso escribe la molienda de cada producto entre parentesis dentro de combo, ej. combo=Maracaturra (grano), Maragogipe (molido)); ' +
  'combo = el producto o combo que pidio el cliente (ej. Bourbon, Africa Mia, Procesos Secretos); direccion = direccion de entrega exacta; nit = NIT para factura; ' +
  'total = monto TOTAL de la venta en quetzales, SOLO EL NUMERO (ej. total=390). Incluye total UNICAMENTE cuando el cliente YA CONFIRMO la compra (acepto pedido y precio); si aun no confirma, NO pongas total. Si el cliente hace OTRA compra despues de una anterior (aunque sea seguido), tratala como VENTA NUEVA: incluye total con el monto de la nueva compra. El sistema reinicia solo el estado de pago a Pendiente para que se confirme el pago de nuevo. Si el cliente solo MODIFICA o REAFIRMA el MISMO pedido (corrige la molienda, aclara un producto, repite lo ya pedido) NO es venta nueva: reenvia el combo corregido pero NO incluyas total; el sistema actualiza el pedido en vez de duplicarlo. ' +
  'forma_pago y estado_pago reflejan SIEMPRE la realidad MAS RECIENTE: si el cliente CAMBIA de metodo (dijo Link pero paga por Transferencia, o al reves), actualiza forma_pago al metodo REAL usado. Si el cliente dice que YA PAGO o envia un comprobante/captura de pago (transferencia, deposito, boleta), pon estado_pago=Por confirmar (NUNCA Pagado: un humano confirma el pago manualmente) y forma_pago segun ese comprobante. En pedidos CONTRA ENTREGA no hay comprobante: cuando el cliente confirma la compra (envias total y forma_pago=Contra entrega) el sistema lo manda solo a la cola de confirmacion para que el equipo lo prepare. ' +
  'Esta marca es INVISIBLE para el cliente; el sistema la guarda en su ficha automaticamente. Nunca la expliques, la muestres ni la menciones.'

const MARKER = /\[\[\s*SET\s*:\s*([^\]]*?)\s*\]\]/gi

export interface DealUpdates {
  payment_method?: string
  payment_status?: string
  grind?: string
  address?: string
  nit?: string
  /** Combo mentioned in this message — appended to combo_history. */
  combo?: string
  /** Total sale amount (Q); written to deal.value on confirmation. */
  total?: string
}

export interface ExtractedDealData {
  /** Reply text with all [[SET:...]] markers removed. */
  cleanText: string
  /** Parsed field updates (empty object when nothing was found). */
  updates: DealUpdates
}

function mapPaymentMethod(v: string): string {
  const s = v.toLowerCase()
  if (s.includes('transfer')) return 'Transferencia'
  if (s.includes('link')) return 'Link de pago'
  if (s.includes('contra')) return 'Contra entrega'
  return v.trim()
}
function mapPaymentStatus(v: string): string {
  const s = v.toLowerCase()
  if (s.includes('confirm')) return 'Por confirmar'
  if (s.includes('pagad')) return 'Pagado'
  if (s.includes('pendiente')) return 'Pendiente'
  return v.trim()
}
function mapGrind(v: string): string {
  const s = v.toLowerCase()
  if (s.includes('molid')) return 'Molido'
  if (s.includes('grano')) return 'Grano'
  return v.trim()
}

/** Pull `[[SET: k=v; ...]]` markers from a reply and parse them. */
export function extractDealMarkers(text: string): ExtractedDealData {
  const updates: DealUpdates = {}
  let m: RegExpExecArray | null
  MARKER.lastIndex = 0
  while ((m = MARKER.exec(text)) !== null) {
    for (const pair of m[1].split(';')) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const key = pair.slice(0, eq).trim().toLowerCase()
      const val = pair.slice(eq + 1).trim()
      if (!val) continue
      switch (key) {
        case 'forma_pago':
          updates.payment_method = mapPaymentMethod(val)
          break
        case 'estado_pago':
          updates.payment_status = mapPaymentStatus(val)
          break
        case 'molienda':
          updates.grind = mapGrind(val)
          break
        case 'combo':
          updates.combo = val
          break
        case 'total':
          updates.total = val
          break
        case 'direccion':
          updates.address = val
          break
        case 'nit':
          updates.nit = val
          break
        default:
          break
      }
    }
  }
  const cleanText = text
    .replace(MARKER, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { cleanText, updates }
}

/**
 * Write parsed updates onto the contact's most recent deal. Combos are
 * appended to combo_history (dated) instead of overwriting so the full
 * purchase history is preserved. Best-effort; swallows all errors.
 */
export async function applyDealUpdates(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
  updates: DealUpdates,
): Promise<void> {
  try {
    const { accountId, contactId } = args
    const hasField =
      updates.payment_method ||
      updates.payment_status ||
      updates.grind ||
      updates.address ||
      updates.nit ||
      updates.combo ||
      updates.total
    if (!hasField) return

    // Most recent deal for this contact in the account — that's the one
    // the current conversation is about.
    const { data: deal } = await db
      .from('deals')
      .select('id, combo_history, sold_at, payment_status, payment_method')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!deal) return

    const patch: Record<string, string> = {}
    if (updates.payment_method) patch.payment_method = updates.payment_method
    if (updates.payment_status) patch.payment_status = updates.payment_status
    if (updates.grind) patch.grind = updates.grind
    if (updates.address) patch.address = updates.address
    if (updates.nit) patch.nit = updates.nit

    if (updates.total) {
      const amount = parseFloat(String(updates.total).replace(/[^0-9.]/g, ''))
      if (Number.isFinite(amount) && amount > 0) {
        patch.value = String(amount)
        const prevSold = (deal as { sold_at?: string | null }).sold_at
        const currentStatus = (
          (deal as { payment_status?: string | null }).payment_status || ''
        ).toLowerCase()
        if (currentStatus.includes('pagad')) {
          // Repeat purchase: the previous sale was already paid, so a new
          // confirmed total means a brand-new order. Restart the payment
          // cycle (back to Pendiente so it must be confirmed again) and
          // stamp a fresh sale date — unless the bot already reported a
          // newer status in this same message.
          if (!updates.payment_status) patch.payment_status = 'Pendiente'
          patch.sold_at = new Date().toISOString()
        } else if (!prevSold) {
          patch.sold_at = new Date().toISOString()
        }
      }
    }

    if (updates.combo) {
      const date = new Date().toISOString().slice(0, 10)
      const line = `[${date}] ${updates.combo}`
      const prev = (deal as { combo_history?: string | null }).combo_history
      if (!prev || !prev.trim()) {
        patch.combo_history = line
      } else if (prev.includes(line)) {
        patch.combo_history = prev
      } else if (updates.total) {
        // A confirmed total means a genuinely NEW order → keep the full
        // history, append a new dated line.
        patch.combo_history = `${prev}\n${line}`
      } else {
        // No new total → modification/reaffirmation of the SAME order
        // (e.g. the customer corrected the grind). Supersede today's
        // existing line instead of stacking a near-duplicate; if there's
        // no line for today, append.
        const lines = prev.split('\n')
        const todayIdx = lines.findIndex((l) => l.startsWith(`[${date}]`))
        if (todayIdx >= 0) {
          lines[todayIdx] = line
          patch.combo_history = lines.join('\n')
        } else {
          patch.combo_history = `${prev}\n${line}`
        }
      }
    }

    // Contra-entrega orders never produce a payment receipt, so they'd
    // never reach the "Por confirmar" review queue the way card/transfer
    // orders do (which land there when the customer sends a receipt). When
    // the customer confirms a cash-on-delivery order (total + forma_pago=
    // Contra entrega), route it into the same queue so the owner gets the
    // alert and reads it as an order to prepare. Only when the model
    // didn't already set an explicit status this turn.
    const effectiveMethod =
      updates.payment_method ||
      (deal as { payment_method?: string | null }).payment_method ||
      ''
    if (
      updates.total &&
      !updates.payment_status &&
      /contra\s*entrega/i.test(effectiveMethod)
    ) {
      patch.payment_status = 'Por confirmar'
    }

    if (Object.keys(patch).length === 0) return
    await db.from('deals').update(patch).eq('id', (deal as { id: string }).id)

    // Fire the owner alert the moment this deal newly enters the
    // "Confirmar pagos" queue (transition INTO 'Por confirmar'). Only on
    // the transition, so we never double-alert. Best-effort, non-blocking.
    const prevStatus = (deal as { payment_status?: string | null }).payment_status || ''
    if (patch.payment_status === 'Por confirmar' && prevStatus !== 'Por confirmar') {
      void notifyPaymentToConfirm(db, {
        accountId,
        contactId,
        value: patch.value ?? updates.total ?? null,
        paymentMethod: effectiveMethod || null,
      })
    }

    // Keep the filterable "Pago: …" tag in sync with the new status.
    if (patch.payment_status) {
      void syncPaymentTag(db, {
        accountId,
        contactId,
        paymentStatus: patch.payment_status,
      })
    }
  } catch (err) {
    console.error('[ai deal-updates] applyDealUpdates failed:', err)
  }
}
