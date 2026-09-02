// ===========================================================================
// EL CARRITO
//
// El pedido en curso guardado como DATOS, no como una frase.
//
// Antes vivia en `combo_history`, texto tipo "[2026-08-31] 04Pacamara", y para
// cobrar habia que volver a interpretarlo. Ahi se perdian las cantidades: el
// bot escribia "Tres bolsas" y el codigo buscaba cifras (Yuri), o nombraba un
// producto dos veces en la misma frase y se contaba doble (Isidro).
//
// El 1 de septiembre esa interpretacion volvio a fallar, y peor. Charles pidio
// Intensa Dulzura con prensa, despues un Maracaturra, despues un Africa Mia.
// El historial quedo en "Intensa Dulzura + prensa francesa + Maracaturra sin
// accesorio" y el lector, al encontrar el combo, hacia `return` ahi mismo y
// tiraba el resto. Cobraba Q490 para siempre. El portero comparaba el mensaje
// del modelo contra ese Q490, no cuadraba, y reemplazaba la respuesta por el
// desglose viejo. Tres veces seguidas el mismo cuadro. Al cliente le parecio
// que el bot no sabia sumar; en realidad el bot estaba amordazado.
//
// Por eso ahora hay DOS caminos, y no valen lo mismo:
//
//   1. LA MARCA. El modelo declara el pedido COMPLETO en cada mensaje:
//        [[CARRITO: 1 Intensa Dulzura con prensa francesa; 1 África Mía]]
//      Eso se guarda como datos y es la fuente de verdad. `origen: 'marca'`.
//
//   2. LA PROSA. Si no hay marca ni carrito guardado, se interpreta el
//      historial como antes. Sirve para los pedidos viejos, pero es una
//      APROXIMACION: `origen: 'texto'`. Un desglose asi NUNCA puede tapar lo
//      que escribio el modelo (ver `pedidoDelDeal` y el portero).
//
// Reglas que no cambian:
//   - El carrito se REEMPLAZA completo, nunca se ajusta. Agregar o quitar algo
//     produce un carrito nuevo y el total se recalcula desde cero.
//   - `combo_history` no se toca: sigue siendo el historial de compras del
//     cliente. Las dos formas conviven y el carrito manda cuando existe.
//
// EL 2 DE SEPTIEMBRE paso otra cosa distinta. Un combo de tres variedades
// (Colosos de America) llevaba cada bolsa con una molienda distinta, y el
// modelo aclaro cual bolsa iba en grano y cual molida pegando esa aclaracion
// entre parentesis al nombre del combo, igual que ya lo hace en el mensaje
// que ve el cliente: "1 Colosos de America (Pacamara grano, Maracaturra
// grano, Maragogipe molido)". El separador de productos de la marca es la
// coma ademas del punto y coma, y esta funcion cortaba por CUALQUIER coma
// sin fijarse si estaba dentro de un parentesis. La aclaracion se hizo
// pedazos, dos de esas variedades (que el catalogo SI reconoce como bolsas
// sueltas de Q120) quedaron como si el cliente las hubiera comprado ADEMAS
// del combo, y la tercera se perdio. `combo_history` termino diciendo
// "Colosos de America + Pacamara + Maracaturra": ni la aclaracion que se
// queria dar, ni el pedido real (que era UN combo, nada mas).
//
// Por eso ahora los parentesis no se tocan al separar productos —lo de
// adentro es una aclaracion del producto anterior, no productos nuevos— y
// esa aclaracion se guarda tal cual en `ItemPedido.detalle`, sin intentar
// interpretarla. Ver `trozosDeCarrito`.
// ===========================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ItemPedido, Accesorio, Desglose } from './caja'
import { calcularPedido } from './caja'
import { CATALOGO, VARIEDADES, sinAcentos } from './enforce-totales'

export interface Carrito {
  items: ItemPedido[]
  accesorioSuelto: Accesorio
  /**
   * De donde salio este carrito.
   *   'marca' → lo declaro el modelo pieza por pieza. Se le cree.
   *   'texto' → se dedujo de una frase. Sirve para orientar, no para cobrar
   *             por encima de lo que dijo el modelo.
   */
  origen?: 'marca' | 'texto'
}

export const CARRITO_VACIO: Carrito = { items: [], accesorioSuelto: 'ninguno' }

/** Numeros escritos con letras, que es donde se rompio el conteo con Yuri. */
const EN_LETRAS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
}

/**
 * Cuantas unidades pide un trozo de texto.
 *
 * Cubre las cuatro formas en que el bot lo escribe, incluidas las dos que
 * antes no se entendian: el numero en letras y el numero detras del producto.
 *   "3 Pacamara"      -> 3
 *   "Tres Pacamara"   -> 3
 *   "Pacamara x 3"    -> 3
 *   "Pacamara"        -> 1
 */
export function cuantasUnidades(trozo: string): number {
  const t = sinAcentos(trozo)
  const atras = t.match(/[x×]\s*(\d{1,3})\b/)
  if (atras) return Number(atras[1])
  const adelante = t.match(/(?:^|\s)(\d{1,3})\s*(?:x\s*)?[a-z]/)
  if (adelante) return Number(adelante[1])
  const letras = t.match(/(?:^|\s)(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s/)
  if (letras) return EN_LETRAS[letras[1]] ?? 1
  return 1
}

/** Lee el carrito guardado. Devuelve null si ese pedido todavia no tiene. */
export function leerCarrito(fila: { carrito?: unknown } | null | undefined): Carrito | null {
  const c = fila?.carrito
  if (!c || typeof c !== 'object') return null
  const obj = c as { items?: unknown; accesorioSuelto?: unknown; origen?: unknown }
  if (!Array.isArray(obj.items)) return null
  const items = obj.items.filter(
    (i): i is ItemPedido =>
      !!i &&
      typeof i === 'object' &&
      typeof (i as ItemPedido).nombre === 'string' &&
      Number.isInteger((i as ItemPedido).cantidad),
  )
  const acc = obj.accesorioSuelto
  return {
    items,
    accesorioSuelto:
      acc === 'prensa' || acc === 'cafetera' ? acc : 'ninguno',
    // Un carrito guardado sin sello es de los primeros; se trata como marca,
    // porque solo se guardan los que el modelo declaro.
    origen: obj.origen === 'texto' ? 'texto' : 'marca',
  }
}

const RE_PRENSA = /prensa\s*francesa|prensa/
const RE_CAFETERA = /cafetera\s*italiana|cafetera|moka/

/** Que accesorio nombra este trozo. */
function accesorioDe(trozo: string): Accesorio {
  if (RE_PRENSA.test(trozo)) return 'prensa'
  if (RE_CAFETERA.test(trozo)) return 'cafetera'
  return 'ninguno'
}

/**
 * El combo que nombra este trozo, si nombra alguno.
 *
 * Exportada: el portero la reusa para juzgar cada linea del desglose contra
 * el catalogo, sin duplicar esta busqueda.
 */
export function buscaCombo(trozo: string) {
  // La cartera importada de Kommo escribe los nombres pegados y con la
  // cantidad delante: "01ColososAmerica", "02MiticoCoban". Comparar sin
  // espacios ni signos hace que esos entren igual que "Colosos de America".
  const compacto = trozo.replace(/[^a-z0-9]/g, '')
  return CATALOGO.find((c) =>
    c.claves.some((k) => {
      const kc = sinAcentos(k).replace(/[^a-z0-9]/g, '')
      return trozo.includes(k) || (kc.length >= 5 && compacto.includes(kc))
    }),
  )
}

/**
 * La variedad suelta que nombra este trozo.
 *
 * Gana el nombre MAS LARGO que coincida: "maracaturra" contiene "caturra" y
 * "kenia sl28" contiene "kenia". Sin esta regla un Maracaturra se guardaba
 * como Caturra, y una Kenia SL28 de Q200 se cobraba como Kenia.
 *
 * Exportada por la misma razon que `buscaCombo`: el portero la reusa.
 */
export function buscaVariedad(trozo: string): [string, number] | undefined {
  const compacto = trozo.replace(/[^a-z0-9]/g, '')
  const candidatas = VARIEDADES.filter(([n]) => {
    const nn = sinAcentos(n)
    return trozo.includes(nn) || compacto.includes(nn.replace(/[^a-z0-9]/g, ''))
  })
  return candidatas.sort((a, b) => b[0].length - a[0].length)[0]
}

/**
 * "caturra roja" -> "Caturra Roja".
 *
 * El catalogo guarda las variedades en minusculas para poder compararlas. Al
 * cliente le llegaba asi tal cual, en medio de un desglose donde los combos si
 * van con mayuscula. Se ve descuidado y es gratis arreglarlo.
 */
function conMayusculas(nombre: string): string {
  return nombre
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bSl(\d)/g, 'SL$1')
}

/**
 * Separa los productos de la marca por `;`, `+`, `,` o salto de linea —
 * pero NUNCA cuando ese separador cae DENTRO de un parentesis. Lo que va
 * entre parentesis es una aclaracion del producto anterior (por ejemplo,
 * que molienda lleva cada bolsa de un combo), no una lista de productos
 * nuevos. Este es el arreglo del bug del 2 de septiembre: ver el
 * comentario grande al inicio del archivo.
 */
function trozosDeCarrito(texto: string): string[] {
    const partes: string[] = []
    let actual = ''
    let profundidad = 0
    for (const ch of texto) {
        if (ch === '(') profundidad++
        else if (ch === ')') profundidad = Math.max(0, profundidad - 1)
        if (profundidad === 0 && /[;+,\n]/.test(ch)) {
            partes.push(actual)
            actual = ''
        } else {
            actual += ch
        }
    }
    partes.push(actual)
    return partes.map((s) => s.trim()).filter(Boolean)
}

/**
 * El corazon del lector: una lista de trozos -> un carrito.
 *
 * Recorre TODOS los trozos. Aca esta el arreglo de fondo del 1 de septiembre:
 * antes, al encontrar un combo, devolvia ese combo y abandonaba el resto del
 * texto. Un pedido de dos combos y una bolsa se cobraba como un solo combo.
 */
function carritoDeLista(bruto: string, origen: 'marca' | 'texto'): Carrito | null {
    const original = String(bruto ?? '').replace(/^\[[^\]]*\]\s*/, '')
    if (!original.trim()) return null

    // Los trozos se separan ANTES de bajarles el acento y la mayuscula, para
    // poder sacar el detalle entre parentesis tal como lo escribio el modelo
    // (ver mas abajo). El resto de la deteccion (combo, variedad, accesorio)
    // sigue trabajando sobre texto normalizado, como siempre.
    const trozosOriginales = trozosDeCarrito(original)

    const items: ItemPedido[] = []
    let accesorioSuelto: Accesorio = 'ninguno'

    for (const trozoOriginal of trozosOriginales) {
        // La cartera de Kommo trae "Kennia" con doble n. Es Kenia SL28, y cuesta
        // Q200: sin esto se cobraba como una bolsa comun.
        const trozo = sinAcentos(trozoOriginal).replace(/kennia/g, 'kenia sl28')

        // "sin accesorio" describe al producto anterior; no es un producto.
        if (/^sin\s+accesorio/.test(trozo)) continue

        const acc = accesorioDe(trozo)

        const combo = buscaCombo(trozo)
        if (combo) {
            // Lo que venga entre parentesis es aclaracion del combo (que grano
            // lleva cada bolsa, por ejemplo), no un producto aparte: se guarda
            // TAL COMO LO ESCRIBIO EL MODELO, sin normalizar ni interpretar.
            // Ver `trozosDeCarrito`.
            const detalle = trozoOriginal.match(/\(([^)]*)\)/)?.[1]?.trim()
            items.push({
                tipo: 'combo',
                nombre: combo.nombre,
                cantidad: cuantasUnidades(trozo),
                accesorio: acc,
                ...(detalle ? { detalle } : {}),
            })
            continue
        }

        const variedad = buscaVariedad(trozo)
        if (variedad) {
            items.push({
                tipo: 'bolsa',
                nombre: conMayusculas(variedad[0]),
                cantidad: cuantasUnidades(trozo),
            })
            continue
        }

        // Trozo que es SOLO un accesorio. Dos lecturas posibles, y la diferencia
        // es de cien quetzales:
        //   "Intensa Dulzura + prensa francesa" -> el combo va CON prensa (Q445).
        //   "2 Pacamara + prensa francesa"      -> la prensa se compra aparte.
        // Se pega al combo anterior cuando ese combo todavia no tiene accesorio;
        // si no hay combo al que pegarse, es una compra suelta.
        if (acc !== 'ninguno') {
            const ultimo = items[items.length - 1]
            if (ultimo && ultimo.tipo === 'combo' && (ultimo.accesorio ?? 'ninguno') === 'ninguno') {
                ultimo.accesorio = acc
            } else {
                accesorioSuelto = acc
            }
        }
    }

    if (items.length === 0 && accesorioSuelto === 'ninguno') return null

    // Un mismo producto nombrado en dos trozos se junta en una linea. Suma las
    // cantidades: "1 Pacamara; 1 Pacamara" son dos bolsas.
    const juntos = new Map<string, ItemPedido>()
    for (const it of items) {
        const llave = `${it.tipo}|${it.nombre}|${it.accesorio ?? 'ninguno'}`
        const previo = juntos.get(llave)
        if (previo) previo.cantidad += it.cantidad
        else juntos.set(llave, { ...it })
    }

    return { items: [...juntos.values()], accesorioSuelto, origen }
}

/**
 * El carrito que el modelo DECLARO en su mensaje.
 *
 * El modelo escribe, en cada respuesta donde haya pedido, el pedido entero:
 *
 *   [[CARRITO: 1 Intensa Dulzura con prensa francesa; 1 África Mía]]
 *
 * Entero, no el cambio. "Agregame un Maracaturra" no produce "1 Maracaturra":
 * produce la lista completa otra vez. Asi el pedido nunca depende de que el
 * codigo entienda una conversacion, que es justo lo que venia fallando.
 *
 * Devuelve null si el mensaje no trae marca.
 */
export function carritoDesdeMarca(texto: string | null | undefined): Carrito | null {
  const m = String(texto ?? '').match(/\[\[\s*CARRITO\s*:([^\]]*)\]\]/i)
  if (!m) return null
  const cuerpo = m[1].trim()
  // [[CARRITO: vacio]] es como el modelo dice "ya no hay pedido".
  if (!cuerpo || /^(vacio|vacío|ninguno|nada)$/i.test(cuerpo)) {
    return { ...CARRITO_VACIO, origen: 'marca' }
  }
  return carritoDeLista(cuerpo, 'marca')
}

/**
 * Traduce una descripcion de pedido al carrito, para los pedidos que vienen
 * del formato viejo (`combo_history`).
 *
 * Devuelve null cuando no reconoce nada: en ese caso se sigue como antes en
 * vez de inventar un pedido.
 */
export function carritoDesdeTexto(texto: string | null | undefined): Carrito | null {
  return carritoDeLista(String(texto ?? ''), 'texto')
}

/** Guarda el carrito del pedido. Best-effort: nunca rompe la conversacion. */
export async function guardarCarrito(
  db: SupabaseClient,
  dealId: string,
  carrito: Carrito,
): Promise<boolean> {
  try {
    const { error } = await db
      .from('deals')
      .update({ carrito, carrito_actualizado_at: new Date().toISOString() })
      .eq('id', dealId)
    if (error) {
      console.error('[carrito] no se pudo guardar:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.error('[carrito] fallo al guardar:', err)
    return false
  }
}

/** Cobra un carrito. Null si el catalogo no reconoce algo. */
export function cobrar(carrito: Carrito | null): Desglose | null {
  if (!carrito || carrito.items.length === 0) return null
  try {
    return calcularPedido(carrito.items, carrito.accesorioSuelto)
  } catch (err) {
    // Un producto fuera de catalogo no puede tumbar la respuesta al cliente.
    console.warn('[carrito] no se pudo calcular:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * El carrito, en el mismo texto libre que antes escribia el campo `combo=`
 * del modelo ("1 Intensa Dulzura con prensa francesa + 1 África Mía").
 *
 * `combo_history` ahora sale de ACA, del carrito ya guardado como datos, en
 * vez de depender de que el modelo declare el mismo pedido DOS veces —una
 * en `[[CARRITO: ...]]` y otra en `combo=...`— sin que se contradigan.
 */
export function textoCarritoParaHistorial(carrito: Carrito): string {
    const partes = carrito.items.map((it) => {
        const sufijo =
            it.tipo === 'combo' && it.accesorio === 'prensa'
        ? ' con prensa francesa'
            : it.tipo === 'combo' && it.accesorio === 'cafetera'
        ? ' con cafetera italiana'
            : ''
        // El detalle (que grano lleva cada bolsa del combo, por ejemplo) queda
        // pegado al nombre entre parentesis: es lo que la tostaduria necesita
        // ver para empacar, y antes se perdia o se convertia en productos falsos.
        const detalle = it.tipo === 'combo' && it.detalle ? ` (${it.detalle})` : ''
        return it.cantidad > 1
        ? `${it.cantidad} ${it.nombre}${sufijo}${detalle}`
            : `${it.nombre}${sufijo}${detalle}`
    })
    if (carrito.accesorioSuelto === 'prensa') partes.push('Prensa francesa')
    if (carrito.accesorioSuelto === 'cafetera') partes.push('Cafetera italiana')
    return partes.join(' + ')
}

/**
 * El pedido de este cliente, y si se puede confiar en el.
 *
 * `confiable` es la pieza nueva y es la que evita el desastre del 1 de
 * septiembre. Solo es true cuando el pedido salio de la marca del modelo. Un
 * desglose deducido de prosa se devuelve igual —sirve para avisar en los
 * logs— pero el portero tiene prohibido usarlo para tapar un mensaje.
 */
export function pedidoDelDeal(
  fila: { carrito?: unknown; combo_history?: string | null } | null | undefined,
): { desglose: Desglose | null; confiable: boolean } {
  const guardado = leerCarrito(fila)
  if (guardado && guardado.items.length > 0) {
    return { desglose: cobrar(guardado), confiable: guardado.origen !== 'texto' }
  }
  const delTexto = carritoDesdeTexto(ultimaLinea(fila?.combo_history))
  return { desglose: cobrar(delTexto), confiable: false }
}

/**
 * El desglose del pedido en curso, o null si no hay carrito ni se pudo
 * reconstruir del historial. Null significa "seguir como antes".
 */
export function desgloseDelPedido(
  fila: { carrito?: unknown; combo_history?: string | null } | null | undefined,
): Desglose | null {
  return pedidoDelDeal(fila).desglose
}

/** El pedido de hoy es la ultima linea del historial. */
function ultimaLinea(historial: string | null | undefined): string {
  return (
    String(historial ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop() ?? ''
  )
}
