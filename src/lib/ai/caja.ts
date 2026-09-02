// ===========================================================================
// LA CAJA REGISTRADORA
//
// Aca vive TODA la aritmetica de un pedido. Codigo puro: no recibe texto, no
// llama a ningun modelo, no adivina nada.
//
// Por que existe: hasta ahora el precio lo escribia el modelo y el codigo
// trataba de atraparlo despues leyendo el mensaje con expresiones regulares.
// Eso no puede funcionar. El bot escribio "Tres bolsas" y el candado buscaba
// cifras (Yuri, cobro Q165 donde eran Q405). Nombro la Caturra Roja dos veces
// en la misma frase y el candado la cobro dos veces (Isidro, Q385 donde eran
// Q265). A la Dra. Flor le agrego una bolsa y le BAJO el total, y termino
// ofreciendole devolver Q75 que no correspondian.
//
// La regla nueva: el modelo dice QUE quiere el cliente. Cuanto cuesta lo dice
// esta funcion, siempre, y siempre desde cero. Un total nunca se "ajusta":
// se recalcula completo.
//
// Los precios son enteros de quetzales. En este catalogo no hay centavos.
// ===========================================================================

import { CATALOGO, VARIEDADES, ACCESORIOS, ENVIO, sinAcentos } from './enforce-totales'

/** Un combo se cotiza distinto segun con que accesorio vaya. */
export type Accesorio = 'ninguno' | 'prensa' | 'cafetera'

export interface ItemPedido {
  /** 'combo' usa la tabla de combos; 'bolsa' usa la de variedades sueltas. */
  tipo: 'combo' | 'bolsa'
  /** Nombre tal como lo conoce el catalogo: 'África Mía', 'Pacamara'. */
  nombre: string
  cantidad: number
  /**
   * Solo para combos: el accesorio cambia el PRECIO del combo, no se suma
   * aparte. Africa Mia sola son Q400; con prensa son Q500, no Q400+Q100.
   * Para bolsas sueltas el accesorio si se suma (ver `accesorioSuelto`).
   */
  accesorio?: Accesorio
  /**
   * Solo para combos: aclaracion en texto libre pegada al pedido (por
   * ejemplo, que grano lleva cada bolsa dentro de un combo con molienda
   * Mixto: "Pacamara grano, Maracaturra grano, Maragogipe molido"). No
   * afecta el precio, es solo para que quede registrado que trae cada
   * bolsa. Ver `carrito.ts` sobre por que esto existe.
   */
  detalle?: string
}

export interface LineaCalculada {
  descripcion: string
  cantidad: number
  /** Precio de UNA unidad, ya con su accesorio si es un combo. */
  unitario: number
  /** unitario x cantidad. */
  total: number
}

export interface Desglose {
  lineas: LineaCalculada[]
  /** Suma de las lineas, sin envio. */
  cafe: number
  /** Q45, uno solo por pedido sin importar cuantas cosas lleve. */
  envio: number
  total: number
}

export class ErrorDeCatalogo extends Error {}

function normalizar(s: string): string {
  return sinAcentos(String(s ?? '')).trim()
}

/** Precio de un combo con el accesorio que lleve. */
function precioCombo(nombre: string, accesorio: Accesorio): number {
  const clave = normalizar(nombre)
  const combo = CATALOGO.find(
    (c) => normalizar(c.nombre) === clave || c.claves.some((k) => normalizar(k) === clave),
  )
  if (!combo) throw new ErrorDeCatalogo(`combo desconocido: ${nombre}`)
  if (accesorio === 'prensa') return combo.prensa
  if (accesorio === 'cafetera') return combo.cafetera
  return combo.solo
}

/** Precio de una bolsa suelta de 400gr. */
function precioBolsa(nombre: string): number {
  const clave = normalizar(nombre)
  // Se busca por coincidencia exacta primero para que "kenia sl28" no caiga
  // en "kenia", que cuesta distinto.
  const exacta = VARIEDADES.find(([n]) => normalizar(n) === clave)
  if (exacta) return exacta[1]
  const parcial = VARIEDADES.find(([n]) => clave.includes(normalizar(n)))
  if (parcial) return parcial[1]
  throw new ErrorDeCatalogo(`variedad desconocida: ${nombre}`)
}

/**
 * Calcula el pedido completo, siempre desde cero.
 *
 * @param items       Lo que lleva el cliente.
 * @param accesorioSuelto Prensa o cafetera comprada aparte, cuando el pedido
 *                    es de bolsas sueltas y no de un combo.
 */
export function calcularPedido(
  items: ItemPedido[],
  accesorioSuelto: Accesorio = 'ninguno',
): Desglose {
  const lineas: LineaCalculada[] = []
  let cafe = 0

  for (const it of items) {
    const cantidad = Number(it.cantidad)
    if (!Number.isInteger(cantidad) || cantidad < 1) {
      throw new ErrorDeCatalogo(`cantidad invalida para ${it.nombre}: ${it.cantidad}`)
    }
    const accesorio = it.accesorio ?? 'ninguno'
    const unitario =
      it.tipo === 'combo' ? precioCombo(it.nombre, accesorio) : precioBolsa(it.nombre)
    const total = unitario * cantidad
    const sufijo =
      it.tipo === 'combo' && accesorio !== 'ninguno'
        ? accesorio === 'prensa'
          ? ' con prensa francesa'
          : ' con cafetera italiana'
        : ''
    lineas.push({ descripcion: `${it.nombre}${sufijo}`, cantidad, unitario, total })
    cafe += total
  }

  // Accesorio comprado suelto junto a bolsas: ahi si se suma como un item mas.
  if (accesorioSuelto !== 'ninguno') {
    const precio = ACCESORIOS[accesorioSuelto]
    const descripcion =
      accesorioSuelto === 'prensa' ? 'Prensa francesa' : 'Cafetera italiana'
    lineas.push({ descripcion, cantidad: 1, unitario: precio, total: precio })
    cafe += precio
  }

  // El envio es uno solo por pedido. Un pedido vacio no paga envio.
  const envio = lineas.length > 0 ? ENVIO : 0
  return { lineas, cafe, envio, total: cafe + envio }
}

/** El desglose en texto, listo para mandar tal cual. */
export function textoDelDesglose(d: Desglose): string {
  const filas = d.lineas.map((l) =>
    l.cantidad > 1
      ? `${l.cantidad}x ${l.descripcion} — Q${l.total}`
      : `${l.descripcion} — Q${l.total}`,
  )
  return [...filas, `Envío — Q${d.envio}`, `*TOTAL: Q${d.total}*`].join('\n')
}
