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

/** Instruction block injected into the auto-reply system prompt so the
 *  model knows to emit the marker. Spanish, matching the Kaffeejager
 *  agent's voice. Kept here so the prompt and the parser stay in sync. */
export const DEAL_EXTRACTION_INSTRUCTIONS =
  'EXTRACCION DE DATOS (INVISIBLE): Cuando en la conversacion el cliente indique o tu confirmes cualquiera de estos datos, agrega al FINAL del mensaje UNA sola marca con este formato EXACTO: ' +
  '[[SET: forma_pago=...; estado_pago=...; molienda=...; combo=...; direccion=...; nit=...]]. ' +
  'Incluye SOLO las claves que conozcas con certeza y omite las demas. ' +
  'Valores permitidos: forma_pago = Link de pago | Transferencia | Contra entrega; estado_pago = Pendiente | Pagado; molienda = Grano | Molido; ' +
  'combo = el producto o combo que pidio el cliente (ej. Bourbon, Africa Mia, Procesos Secretos); direccion = direccion de entrega exacta; nit = NIT para factura. ' +
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
      updates.combo
    if (!hasField) return

    // Most recent deal for this contact in the account — that's the one
    // the current conversation is about.
    const { data: deal } = await db
      .from('deals')
      .select('id, combo_history')
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

    if (updates.combo) {
      const date = new Date().toISOString().slice(0, 10)
      const line = `[${date}] ${updates.combo}`
      const prev = (deal as { combo_history?: string | null }).combo_history
      // Avoid duplicating the exact same combo on the same day.
      patch.combo_history =
        prev && prev.trim()
          ? prev.includes(line)
            ? prev
            : `${prev}\n${line}`
          : line
    }

    if (Object.keys(patch).length === 0) return
    await db.from('deals').update(patch).eq('id', (deal as { id: string }).id)
  } catch (err) {
    console.error('[ai deal-updates] applyDealUpdates failed:', err)
  }
}
