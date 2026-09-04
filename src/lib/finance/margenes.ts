// ===========================================================================
// GANANCIA POR PEDIDO
//
// Le calcula el costo (y por lo tanto la ganancia) a un pedido ya cobrado
// por `caja.ts`. Los margenes vienen de la pestaña "Costos Combos" de la
// hoja Finanzas Kaffeejager (snapshot leido el 4-9-2026):
//
//   https://docs.google.com/spreadsheets/d/17Eb7vDp1znb7Kwy38q4bOlLOAaQlapQGrdTR7MZwzdE
//
// Esa hoja calcula, para cada combo, Ganancia = Precio Venta - Costo Total -
// Envio Caex. De ahi sale el margen (Ganancia / Precio Venta) que usamos
// aca. La hoja solo trae un costo de referencia por combo (no uno por cada
// combinacion de accesorio), asi que el mismo margen se aplica sin importar
// si el combo llevo prensa, cafetera o nada — es una aproximacion, no una
// contabilidad exacta. Si la hoja cambia sus costos, estos numeros quedan
// desactualizados y hay que volver a leerla.
//
// El costo de una bolsa suelta usa el "Costo Variable por unidad" de la
// pestaña "Costos Variables" (tier CASA, la presentacion que se vende):
// café pergamino + bolsa de empaque. Es el mismo costo para cualquier
// variedad porque la hoja no separa el costo del grano por variedad.
// ===========================================================================

import type { Carrito } from '../ai/carrito'
import { leerCarrito, carritoDesdeTexto, cobrar } from '../ai/carrito'
import { sinAcentos } from '../ai/enforce-totales'

/** Ganancia (Precio Venta − Costo Total − Envío) / Precio Venta, por combo. */
const MARGEN_COMBO: Record<string, number> = {
  'procesos secretos': 0.429,
  'colosos de america': 0.379,
  'intensa dulzura': 0.379,
  'mitico coban': 0.514,
  'africa mia': 0.405,
  // "Combos Casa Kaffejager" en la hoja: 4 presentaciones (Combo 2 a 5) del
  // mismo Highland Coban, margen 31%-42%. Se promedia.
  'highland coban': 0.39,
}

/** Margen cuando el combo no aparece en la hoja (ninguno hasta ahora). */
const MARGEN_COMBO_DEFECTO = 0.4

/** Costo de una bolsa de 400gr, cualquier variedad (tier CASA). */
const COSTO_BOLSA = 26.86

/** Costo de un accesorio comprado suelto (no dentro de un combo). */
const COSTO_ACCESORIO: Record<'prensa' | 'cafetera', number> = {
  prensa: 40, // "Coleccion Ultra Instinto 100g", linea Prensa Francesa
  cafetera: 95, // "Africa Mia", linea Articulo
}

/** Lo que se le cobra al cliente por envío (ver ENVIO en enforce-totales.ts). */
const ENVIO_COBRADO = 45
/** Lo que de verdad cuesta el envío (Envio Caex en la hoja de costos). */
const ENVIO_COSTO = 26

function margenDeCombo(nombre: string): number {
  const clave = sinAcentos(nombre).trim()
  return MARGEN_COMBO[clave] ?? MARGEN_COMBO_DEFECTO
}

export interface MargenPedido {
  /** Venta del pedido segun el catalogo (puede diferir un poco del `value` real guardado). */
  ventaCatalogo: number
  /** Costo estimado del mismo pedido. */
  costoCatalogo: number
}

/**
 * Costo estimado de un carrito ya cobrado. Devuelve null si el carrito esta
 * vacio o el catalogo no reconoce algo (mismo caso en que `cobrar` da null).
 */
export function margenDelCarrito(carrito: Carrito | null): MargenPedido | null {
  const desglose = cobrar(carrito)
  if (!desglose || !carrito) return null

  let costoCafe = 0
  desglose.lineas.forEach((linea, i) => {
    const it = carrito.items[i]
    if (!it) return // la linea del accesorio suelto, si la hay, se trata abajo
    if (it.tipo === 'combo') {
      costoCafe += linea.total * (1 - margenDeCombo(it.nombre))
    } else {
      costoCafe += COSTO_BOLSA * it.cantidad
    }
  })
  if (carrito.accesorioSuelto === 'prensa' || carrito.accesorioSuelto === 'cafetera') {
    costoCafe += COSTO_ACCESORIO[carrito.accesorioSuelto]
  }

  const costoEnvio = desglose.envio > 0 ? ENVIO_COSTO : 0
  return { ventaCatalogo: desglose.total, costoCatalogo: costoCafe + costoEnvio }
}

/** El costo del pedido de este deal, leyendo el mismo carrito que ya usa el bot. */
export function margenDelDeal(
  fila: { carrito?: unknown; combo_history?: string | null } | null | undefined,
): MargenPedido | null {
  const guardado = leerCarrito(fila)
  if (guardado && guardado.items.length > 0) return margenDelCarrito(guardado)
  const ultima =
    String(fila?.combo_history ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop() ?? ''
  return margenDelCarrito(carritoDesdeTexto(ultima))
}

/**
 * Margen promedio cuando no se pudo leer el carrito del pedido (deals
 * importados sin combo_history reconocible, por ejemplo). Se aplica sobre
 * el `value` real del deal para no dejarlo fuera de la ganancia del mes.
 */
export const MARGEN_PROMEDIO_RESPALDO = 0.38

export { ENVIO_COBRADO, ENVIO_COSTO }
