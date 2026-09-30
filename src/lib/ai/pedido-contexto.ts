/**
 * Contexto del pedido anterior del cliente, con FECHA y ANTIGUEDAD.
 *
 * El 30-09 Lucia Ibarguen toco "Programar pedido" (boton del masivo) y dijo
 * "si, esos". Su ultimo pedido (15-08) estaba Pagado y el bot contesto "queda
 * ese mismo pedido, ya pagado": tomo una recompra por el pedido viejo. Luego
 * ella pidio el link de pago y el bot se rindio con [[HANDOFF]].
 *
 * Regla: un pedido pagado NO es "el pedido actual" solo por ser el ultimo.
 * Segun su antiguedad el bot lo trata como cerrado, dudoso (pregunta) o vivo.
 */

export interface DealParaContexto {
  value: number | string | null
  payment_status: string | null
  payment_method: string | null
  combo_history: string | null
  notes: string | null
  created_at: string
  sold_at?: string | null
}

const DIA_MS = 86_400_000
/** Hasta aqui un pedido pagado puede seguir siendo "el mismo" (duda → preguntar). */
export const VENTANA_PEDIDO_RECIENTE_DIAS = 7

function dias(desde: string | null | undefined, ahora: number): number | null {
  if (!desde) return null
  const t = new Date(desde).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((ahora - t) / DIA_MS))
}

export function construirContextoPedido(
  deal: DealParaContexto,
  ahora: number = Date.now(),
): string {
  const ultimoCombo = (deal.combo_history || '').trim().split('\n').pop() || '—'
  const estado = (deal.payment_status ?? '').trim()
  const pagado = /pagad/i.test(estado)
  const enCola = /por confirmar/i.test(estado)
  const fechaBase = deal.sold_at || deal.created_at
  const edad = dias(fechaBase, ahora)
  const fecha = String(fechaBase ?? '').slice(0, 10)
  const total = `Q${deal.value ?? 0}`

  const ficha =
    `\n\nPEDIDO MAS RECIENTE DE ESTE CLIENTE SEGUN EL CRM (fuente de verdad): ` +
    `producto: ${ultimoCombo}; total: ${total}; ` +
    `estado de pago: ${estado || 'sin registrar'}; ` +
    `forma de pago: ${deal.payment_method ?? '—'}; ` +
    `fecha: ${fecha || '—'}${edad !== null ? ` (hace ${edad} dia${edad === 1 ? '' : 's'})` : ''}` +
    (deal.notes ? `; nota: ${deal.notes}` : '') +
    `. `

  // 1) Pagado y viejo: pedido CERRADO. Todo lo que pida ahora es NUEVO.
  if (pagado && edad !== null && edad > VENTANA_PEDIDO_RECIENTE_DIAS) {
    return (
      ficha +
      `ESE PEDIDO ESTA CERRADO (pagado hace ${edad} dias). Todo lo que el cliente pida ahora ` +
      `—aunque diga "programar pedido", "los mismos", "esos" o "como la vez pasada"— es un PEDIDO NUEVO: ` +
      `armalo con su carrito, calcula el total nuevo y pide forma de pago. JAMAS digas que "ya esta pagado" ` +
      `ni que "queda ese mismo pedido". Si pide "lo mismo", nombrale lo que compro antes y confirmale el total NUEVO. ` +
      `Solo si pregunta por la entrega o manda un comprobante de algo reciente, tratalo como pedido existente. ` +
      `Si pide un link de pago o cuenta, dalos: NUNCA lo pases a un humano por eso.`
    )
  }

  // 2) Pagado y reciente (<= 7 dias): puede ser el mismo o uno nuevo → preguntar.
  if (pagado) {
    return (
      ficha +
      `ESE PEDIDO YA ESTA PAGADO y es reciente (${edad ?? '?'} dias). Decide asi: ` +
      `(a) si pregunta por la entrega o el estado, o manda un comprobante que cuadra con el, es ESE pedido: ` +
      `no lo confirmes de nuevo ni emitas total. ` +
      `(b) si pide cafe, dice "programar pedido", "esos", "lo mismo", o dice que TODAVIA NO HA PAGADO o pide link, ` +
      `NO asumas. Pregunta claro y corto: "¿Se refiere al pedido del ${fecha} (${ultimoCombo}) que ya esta pagado, o desea uno nuevo?" ` +
      `y espera. Si dice que es nuevo (o que debe/no ha pagado), es PEDIDO NUEVO: calcula el total nuevo y sigue la venta normal. ` +
      `Nunca digas "ya pagado" sobre lo que el cliente acaba de pedir sin haberlo confirmado. ` +
      `Si pide un link de pago o cuenta, dalos: NUNCA lo pases a un humano por eso.`
    )
  }

  // 3) En cola / en proceso / sin registrar: pedido vivo (regla de siempre).
  return (
    ficha +
    `REGLA CRITICA: si el cliente pregunta por la entrega, el estado, o manda un pago/comprobante ` +
    `que corresponde a ESTE pedido (aunque hayan pasado dias), relacionalo con el pedido EXISTENTE: ` +
    `NO lo confirmes de nuevo, NO emitas total${enCola ? ', y NO pongas estado_pago otra vez' : ''}. ` +
    `Trata la conversacion como VENTA NUEVA solo si el cliente pide explicitamente comprar OTRA vez. ` +
    `Si tienes duda, pregunta con comunicacion asertiva, por ejemplo: ` +
    `"¿Me confirma si se refiere a su pedido anterior o desea hacer un pedido nuevo?" ` +
    `Si pide un link de pago o cuenta, dalos: NUNCA lo pases a un humano por eso.`
  )
}
