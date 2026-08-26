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
  '[[SET: nombre=...; forma_pago=...; estado_pago=...; molienda=...; combo=...; direccion=...; nit=...; notas=...]]. ' +
  'Incluye SOLO las claves que conozcas con certeza y omite las demas. ' +
  'Valores permitidos: forma_pago = Link de pago | Transferencia | Contra entrega; estado_pago = Pendiente | Por confirmar (nunca pongas Pagado; SOLO el equipo lo marca a mano); molienda = Grano | Molido | Mixto (usa Mixto SOLO cuando en un mismo pedido unos productos van en grano y otros molidos; en ese caso escribe la molienda de cada producto entre parentesis dentro de combo, ej. combo=Maracaturra (grano), Maragogipe (molido)); ' +
  'combo = la lista COMPLETA Y ACTUAL de productos del pedido, no uno solo. Si el pedido lleva varios productos escribelos juntos separados por " + " (ej. combo=Mitico Coban + Africa Mia). Si el cliente CAMBIA de producto (se arrepiente y pide otro), manda SOLO el producto nuevo: el sistema reemplaza el anterior, no lo suma. direccion = direccion de entrega exacta; nit = NIT para factura; notas = nota o instruccion especial del pedido, sobre todo REGALOS (formato: Regalo para [destinatario], de parte de [comprador]); ' +
  'total = monto TOTAL de la venta en quetzales, SOLO EL NUMERO (ej. total=390). Incluye total UNICAMENTE cuando el cliente YA CONFIRMO la compra (acepto pedido y precio); si aun no confirma, NO pongas total. Si el cliente hace OTRA compra despues de una anterior (aunque sea seguido), tratala como VENTA NUEVA: incluye total con el monto de la nueva compra. El sistema reinicia solo el estado de pago a Pendiente para que se confirme el pago de nuevo. Si el cliente solo MODIFICA o REAFIRMA el MISMO pedido (corrige la molienda, aclara un producto, repite lo ya pedido) NO es venta nueva: reenvia el combo corregido pero NO incluyas total; el sistema actualiza el pedido en vez de duplicarlo. ' +
  'forma_pago y estado_pago reflejan SIEMPRE la realidad MAS RECIENTE: si el cliente CAMBIA de metodo (dijo Link pero paga por Transferencia, o al reves), actualiza forma_pago al metodo REAL usado. Si el cliente dice que YA PAGO o envia un comprobante/captura de pago (transferencia, deposito, boleta), pon estado_pago=Por confirmar (NUNCA Pagado: un humano confirma el pago manualmente) y forma_pago segun ese comprobante. En pedidos CONTRA ENTREGA no hay comprobante: cuando el cliente confirma la compra (envias total y forma_pago=Contra entrega) el sistema lo manda solo a la cola de confirmacion para que el equipo lo prepare. ' +
  'nombre = nombre y apellido REAL del cliente, tal como el lo escribio. En cuanto te lo diga, incluyelo. ' +
  'REGLA DEL NOMBRE: NO puedes cerrar un pedido sin el nombre del cliente. Si vas a confirmar la compra y todavia no sabes como se llama, PIDESELO en esa misma linea ' +
  '(ej. "Perfecto 😊 ¿A nombre de quien preparo el pedido?") y no mandes total hasta tenerlo. El nombre del perfil de WhatsApp NO cuenta como nombre confirmado. ' +
  'REGLA DEL ENVIO (critica): los precios del catalogo son SIN ENVIO. TODO pedido paga Q45 de envio, uno solo por pedido. El total que le das al cliente y el que mandas en total= ' +
  'SIEMPRE es precio del cafe + Q45. Ejemplos: Africa Mia con cafetera italiana Q545 -> total=590. Africa Mia sola Q400 -> total=445. Mitico Coban Q345 -> total=390. Una bolsa de Q120 -> total=165. ' +
  'Nunca des como total el precio pelado del catalogo: si el numero que ibas a decir aparece tal cual en el catalogo, te falto sumar el envio. ' +
  'Esta marca es INVISIBLE para el cliente; el sistema la guarda en su ficha automaticamente. Nunca la expliques, la muestres ni la menciones.'

const MARKER = /\[\[\s*SET\s*:\s*([^\]]*?)\s*\]\]/gi

/** Rellenos que el sistema pone solo y que NO son el nombre de nadie. */
const NOMBRES_DE_RELLENO = ['lead whatsapp', 'cliente', 'sin nombre', 'contacto', '.', '..', '...']

/** ¿Sirve este nombre para rotular una guia de envio? */
function esNombreUsable(nombre: string, telefono: string): boolean {
  const n = (nombre || '').trim()
  if (n.length < 3) return false
  if (n === telefono) return false
  if (NOMBRES_DE_RELLENO.includes(n.toLowerCase())) return false
  // Puro numero (el telefono con o sin formato) no es un nombre.
  if (!/[a-zá-úñ]{3}/i.test(n)) return false
  return true
}

export interface DealUpdates {
  /** Nombre real del cliente, dicho por el en el chat. */
  nombre?: string
  payment_method?: string
  payment_status?: string
  grind?: string
  address?: string
  nit?: string
  /** Combo mentioned in this message — appended to combo_history. */
  combo?: string
  /** Total sale amount (Q); written to deal.value on confirmation. */
  total?: string
  /** Free-form order note (e.g. gift recipient) -> deal.notes. */
  notes?: string
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
        case 'nombre':
          updates.nombre = val
          break
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
        case 'notas':
          updates.notes = val
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
      updates.notes ||
      updates.combo ||
      updates.total ||
      updates.nombre
    if (!hasField) return

    // --- NOMBRE DEL CLIENTE ---------------------------------------
    // Cuando el cliente dice como se llama hay que guardarlo en su ficha;
    // antes se perdia y habia que escribirlo a mano.
    //
    // OJO con dos cosas distintas:
    //  • Para ESCRIBIR respetamos el mismo candado del webhook: si el
    //    equipo ya renombro la tarjeta a mano, ese nombre manda.
    //  • Para el CANDADO de la cola de confirmacion basta con que haya un
    //    nombre utilizable para la guia de envio. El nombre del perfil de
    //    WhatsApp SI sirve; lo que no sirve es un vacio, el propio numero
    //    o un relleno tipo "Lead WhatsApp".
    let nombreUtilizable = ''
    try {
      const { data: cont } = await db
        .from('contacts')
        .select('name, phone, wa_profile_name')
        .eq('id', contactId)
        .maybeSingle()
      const actual = String(cont?.name ?? '').trim()
      const perfil = String(cont?.wa_profile_name ?? '').trim()
      const telefono = String(cont?.phone ?? '').trim()

      if (updates.nombre) {
        const editadoAMano = !!actual && actual !== perfil && actual !== telefono
        const limpio = updates.nombre.trim().slice(0, 80)
        if (limpio && !editadoAMano && limpio !== actual) {
          await db
            .from('contacts')
            .update({ name: limpio, updated_at: new Date().toISOString() })
            .eq('id', contactId)
          nombreUtilizable = limpio
        }
      }
      if (!nombreUtilizable) nombreUtilizable = esNombreUsable(actual, telefono) ? actual : ''
    } catch (e) {
      console.error('[deal-updates] no se pudo guardar el nombre:', e)
      // Ante la duda no bloqueamos la venta.
      nombreUtilizable = 'desconocido'
    }

    // Most recent deal for this contact in the account — that's the one
    // the current conversation is about.
    const { data: deal } = await db
      .from('deals')
      .select(
        'id, combo_history, sold_at, payment_status, payment_method, stage_id, pipeline_id, confirm_requested_at',
      )
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!deal) return

    const patch: Record<string, string | null> = {}
    if (updates.payment_method) patch.payment_method = updates.payment_method
    if (updates.payment_status) patch.payment_status = updates.payment_status
    if (updates.grind) patch.grind = updates.grind
    if (updates.address) patch.address = updates.address
    if (updates.nit) patch.nit = updates.nit
    if (updates.notes) patch.notes = updates.notes

    // El titulo de la tarjeta y el nombre del contacto tienen que decir
    // lo mismo: con uno se rotula la guia de Cargo Expreso y el otro es
    // el que ve el equipo en el tablero. Verlos distintos ya causo
    // confusion (tarjeta "Marisol" con contacto "Geogina").
    if (nombreUtilizable && nombreUtilizable !== 'desconocido') {
      patch.title = nombreUtilizable
    }

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
          // Pedido NUEVO: se borra la marca del anterior para que este si
          // pueda avisar cuando le toque entrar a la cola.
          patch.confirm_requested_at = null
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
      } else if (
        updates.total &&
        ((deal as { payment_status?: string | null }).payment_status || '')
          .toLowerCase()
          .includes('pagad')
      ) {
        // RECOMPRA genuina: el pedido anterior ya estaba pagado, así que
        // esto es una orden nueva → se conserva el histórico y se agrega
        // una línea nueva.
        patch.combo_history = `${prev}\n${line}`
      } else {
        // MISMO pedido en curso (el cliente corrigió la molienda, cambió
        // de café o reafirmó): el combo que manda el bot es la lista
        // COMPLETA y actual, así que REEMPLAZA la línea de hoy en vez de
        // apilar productos. Antes se acumulaban: un cliente que cambiaba
        // Colosos por África Mía terminaba con los dos en el pedido.
        const previousDays = prev
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith(`[${date}]`))
        patch.combo_history = [...previousDays, line].join('\n')
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
    const declaredStatus = (updates.payment_status || '').toLowerCase()
    if (
      updates.total &&
      /contra\s*entrega/i.test(effectiveMethod) &&
      !declaredStatus.includes('pagad') &&
      !declaredStatus.includes('confirmar')
    ) {
      // Antes solo entraba cuando el modelo NO mandaba estado. Pero el bot
      // suele mandar estado_pago=Pendiente al confirmar un contra entrega, y
      // eso dejaba el pedido fuera de la cola: el equipo nunca lo veía. Un
      // contra entrega CONFIRMADO (con total) siempre va a "Por confirmar",
      // salvo que ya venga como Pagado o Por confirmar.
      patch.payment_status = 'Por confirmar'
    }

    // CANDADO: sin nombre del cliente el pedido NO entra a la cola de
    // confirmacion. Sin nombre no se puede rotular la guia de Cargo
    // Expreso y el equipo terminaba persiguiendo el dato despues de que
    // el pedido ya estaba "listo". Se queda en Pendiente; el bot tiene
    // instruccion de pedir el nombre antes de cerrar (REGLA DEL NOMBRE).
    if (patch.payment_status === 'Por confirmar' && !nombreUtilizable) {
      console.warn(
        `[deal-updates] deal ${deal.id}: sin nombre de cliente, se queda en Pendiente en vez de entrar a Confirmar pagos`,
      )
      patch.payment_status = 'Pendiente'
    }

    // Never drag an already-PAID order back into the confirmation queue
    // unless this same message carries a NEW confirmed total (a genuinely
    // new purchase). A late "ya pagué", a re-sent receipt, or a delivery
    // question on a paid order must not restart the payment cycle — that
    // was the Rocío / Dr. Jovito duplicate-confirmation bug.
    const paidAlready = (
      (deal as { payment_status?: string | null }).payment_status || ''
    )
      .toLowerCase()
      .includes('pagad')
    if (
      paidAlready &&
      !updates.total &&
      (patch.payment_status === 'Por confirmar' ||
        patch.payment_status === 'Pendiente')
    ) {
      delete patch.payment_status
    }

    // --- Auto-mover la tarjeta en el pipeline según la señal del bot ---
    // El bot maneja el tablero solo; el dueño solo confirma el pago.
    //   • El cliente muestra intención de compra (el bot menciona un
    //     producto → `combo`) y está en "Nuevos Leads" o "Ganados"
    //     (cliente viejo re-interesado) → pasa a "Negociación" para
    //     tenerlo visible y empujar la venta.
    //   • Llega comprobante de pago / se confirma contra-entrega
    //     (payment_status → "Por confirmar") → pasa a "Pedidos
    //     Confirmados" (y ya estaba entrando a la cola Confirmar pagos).
    // Nunca se mueve hacia atrás una tarjeta ya Enviada/en Pedidos.
    try {
      const pipelineId = (deal as { pipeline_id?: string | null }).pipeline_id
      const curStage = (deal as { stage_id?: string | null }).stage_id
      if (pipelineId) {
        const { data: stages } = await db
          .from('pipeline_stages')
          .select('id, name')
          .eq('pipeline_id', pipelineId)
        const byName: Record<string, string> = {}
        for (const s of stages ?? []) byName[s.name as string] = s.id as string
        const nuevos = byName['Nuevos Leads']
        const negociacion = byName['Negociación']
        const pedidos = byName['Pedidos Confirmados']
        const enviado = byName['Enviado']
        const ganados = byName['Ganados']

        let targetStage: string | undefined
        if (
          patch.payment_status === 'Por confirmar' &&
          pedidos &&
          curStage !== pedidos &&
          curStage !== enviado
        ) {
          // Comprobante / contra-entrega confirmada → Pedidos Confirmados.
          targetStage = pedidos
        } else if (
          updates.combo &&
          negociacion &&
          (curStage === nuevos || curStage === ganados)
        ) {
          // Interés de compra → Negociación (nuevo lead o cliente viejo
          // que vuelve a interesarse).
          targetStage = negociacion
        }
        if (targetStage && targetStage !== curStage) {
          patch.stage_id = targetStage
          patch.stage_entered_at = new Date().toISOString()
        }
      }
    } catch (err) {
      console.error('[ai deal-updates] auto stage move failed:', err)
    }

    if (Object.keys(patch).length === 0) return
    await db.from('deals').update(patch).eq('id', (deal as { id: string }).id)

    // Aviso al duenio cuando el pedido entra a "Confirmar pagos".
    //
    // Antes se comparaba contra `deal.payment_status`, que es una FOTO leida al
    // inicio de esta funcion. Si dos caminos corren para el mismo mensaje (pasa
    // con las imagenes: las atiende image-reply y si la llamada de vision falla
    // cae al camino de texto), los dos leen la misma foto vieja y los dos
    // avisan. Le paso a Luis Lopez Bonilla el 25-08.
    //
    // Ahora el aviso se RECLAMA en la base: gana quien logre poner la marca
    // estando en null. El segundo no recibe fila y se calla. Mismo patron que
    // claim_ai_reply_slot.
    if (patch.payment_status === 'Por confirmar') {
      const { data: reclamado } = await db
        .from('deals')
        .update({ confirm_requested_at: new Date().toISOString() })
        .eq('id', (deal as { id: string }).id)
        .is('confirm_requested_at', null)
        .select('id')
        .maybeSingle()

      if (reclamado) {
        void notifyPaymentToConfirm(db, {
          accountId,
          contactId,
          value: patch.value ?? updates.total ?? null,
          paymentMethod: effectiveMethod || null,
        })
      } else {
        console.log(
          `[deal-updates] deal ${(deal as { id: string }).id}: ya estaba en la cola de confirmacion, no se repite el aviso`,
        )
      }
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
