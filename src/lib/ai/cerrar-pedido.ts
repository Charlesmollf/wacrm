import {
  CATALOGO,
  ACCESORIOS,
  ENVIO,
  sinAcentos,
  precioDeBolsas,
  type Combo,
} from './enforce-totales'

/**
 * Cierre automatico del pedido.
 *
 * POR QUE EXISTE
 *
 * El bot mandaba el resumen final ("☕ Producto... ¿Esta todo
 * correcto?") y se quedaba esperando que el cliente contestara "si".
 * Ese "si" casi nunca llega: el cliente ya dio todos los datos y da la
 * compra por hecha. Resultado: el pedido se queda en Negociacion, sin
 * total, y nadie lo prepara. Le paso a Davies Guit el 31-08 — dio
 * producto, molienda, direccion, telefono y forma de pago, y el pedido
 * quedo colgado con Q0.
 *
 * Ahora el resumen es un AVISO, no una pregunta que bloquea: si estan
 * todos los datos, el pedido entra solo a la cola de confirmacion. El
 * cliente puede corregir despues — para eso el resumen le dice que
 * avise si algo cambio, y el equipo revisa la cola antes de despachar.
 *
 * EL CANDADO
 *
 * "Todos los datos" no es opcional: sin ellos la tostaduria no puede
 * rotular la guia de Cargo Expreso. Los datos pueden venir del mensaje
 * de ahora o de lo ya guardado en la ficha (una recompra ya tiene la
 * direccion). Si falta uno, el pedido NO entra a la cola y el bot
 * sigue pidiendolo.
 */

/** Lo minimo para poder preparar y rotular un envio. */
export interface DatosPedido {
  nombre?: string | null
  combo?: string | null
  molienda?: string | null
  formaPago?: string | null
  direccion?: string | null
  telefono?: string | null
  total?: number | null
}

const vacio = (v: string | null | undefined) => !v || !String(v).trim()

/**
 * Que datos faltan para poder mandar el pedido a confirmar. Lista
 * vacia = se puede cerrar.
 *
 * El total NO esta en la lista: se calcula del catalogo cuando falta
 * (`totalDelPedido`). Los demas no se pueden inventar.
 */
export function datosQueFaltan(d: DatosPedido): string[] {
  const faltan: string[] = []
  if (vacio(d.nombre) || d.nombre === 'desconocido') faltan.push('nombre')
  if (vacio(d.combo)) faltan.push('producto')
  if (vacio(d.molienda)) faltan.push('molienda')
  if (vacio(d.formaPago)) faltan.push('forma de pago')
  if (vacio(d.direccion)) faltan.push('direccion')
  if (vacio(d.telefono)) faltan.push('telefono')
  return faltan
}

/**
 * Precio del cafe de un pedido YA ARMADO (lo que quedo en `combo`),
 * sin envio. Devuelve null si algo del pedido no esta en el catalogo:
 * mejor no cerrar que cerrar con un monto inventado.
 *
 * Ojo, es distinto de `precioEsperadoDelCafe`, que lee el TEXTO de un
 * mensaje y a proposito devuelve null cuando ve dos combos (ahi suele
 * ser una comparativa: "tenemos Mitico Coban y Africa Mia"). Aca dos
 * combos significan que el cliente se lleva los dos, y se suman. A
 * Davies le vendimos "Africa Mia + Procesos Secretos" y el bot le
 * cobro Q645 cuando eran Q685.
 */
export function precioDelPedido(combo: string | null | undefined): number | null {
  if (!combo) return null
  // Le puede venir la fecha del historial: "[2026-08-31] Africa Mia".
  const plano = sinAcentos(String(combo)).replace(/^\[[^\]]*\]\s*/, '')
  const trozos = plano.split('+').map((t) => t.trim()).filter(Boolean)
  if (trozos.length === 0) return null

  const combos: Combo[] = []
  const accesorios: ('prensa' | 'cafetera')[] = []
  let bolsas = 0
  let nBolsas = 0

  for (const trozo of trozos) {
    if (/prensa\s+francesa/.test(trozo)) {
      accesorios.push('prensa')
      continue
    }
    if (/cafetera\s+italiana|moka/.test(trozo)) {
      accesorios.push('cafetera')
      continue
    }
    const c = CATALOGO.find((c) => c.claves.some((k) => trozo.includes(k)))
    if (c) {
      combos.push(c)
      continue
    }
    const b = precioDeBolsas(trozo)
    if (b !== null) {
      bolsas += b
      nBolsas++
      continue
    }
    // Un trozo que no se reconoce: no se adivina el precio.
    return null
  }

  if (combos.length === 0 && nBolsas === 0) return null

  // Un combo solo con su accesorio: manda la TABLA, que trae precios de
  // paquete. Africa Mia con cafetera son Q545, no 400 + 200.
  if (combos.length === 1 && nBolsas === 0) {
    if (accesorios.length > 1) return null
    const c = combos[0]
    if (accesorios[0] === 'prensa') return c.prensa
    if (accesorios[0] === 'cafetera') return c.cafetera
    return c.solo
  }

  // Varios productos: se suman a precio de lista.
  let total = bolsas
  for (const c of combos) total += c.solo
  for (const a of accesorios) total += ACCESORIOS[a]
  return total
}

/** Total que se le cobra al cliente: cafe + el unico envio del pedido. */
export function totalDelPedido(combo: string | null | undefined): number | null {
  const cafe = precioDelPedido(combo)
  return cafe === null ? null : cafe + ENVIO
}

export interface Cierre {
  /** true si el pedido puede entrar a la cola de confirmacion. */
  cerrar: boolean
  /** Total a guardar cuando el pedido no traia uno. */
  total?: number
  /** Que falto, para el log. */
  faltan: string[]
}

/**
 * Decide si un pedido puede cerrarse solo y con que total.
 *
 * No cierra si falta un dato, ni si no se puede calcular el total y el
 * pedido tampoco trae uno.
 */
export function evaluarCierre(d: DatosPedido): Cierre {
  const faltan = datosQueFaltan(d)
  if (faltan.length > 0) return { cerrar: false, faltan }

  const yaTiene = Number(d.total) > 0
  if (yaTiene) return { cerrar: true, faltan: [] }

  const calculado = totalDelPedido(d.combo)
  if (calculado === null) {
    return { cerrar: false, faltan: ['total (el producto no esta en el catalogo)'] }
  }
  return { cerrar: true, total: calculado, faltan: [] }
}
