// ===========================================================================
// EL PORTERO
//
// Ningun mensaje sale al cliente sin pasar por aca. Es verificacion DURA:
// codigo puro, sin modelo, sobre cosas que tienen una unica respuesta
// correcta. Cuesta cero y no se equivoca.
//
// Un modelo NUNCA debe validar aritmetica: si le preguntas "¿esta bien esta
// suma?" contesta que si con toda confianza aunque este mal, y eso es peor
// que no verificar porque da tranquilidad falsa.
//
// HASTA EL 1 DE SEPTIEMBRE esto comparaba el mensaje contra un `Desglose`
// guardado aparte (el carrito). El 1-9 el carrito quedo incompleto —le
// faltaba una cafetera suelta— y el portero freno un mensaje que estaba
// BIEN, lo reemplazo por el total viejo (Q405) y se lo repitio al cliente
// dos veces. El cliente nunca vio el Q605 correcto. El carrito puede estar
// mal por mil razones (el modelo no declaro la marca, la declaro a medias);
// pedirle al portero que confie en el es pedirle que herede ese error.
//
// Ahora el portero no necesita NINGUN carrito. Verifica el desglose que EL
// PROPIO MENSAJE escribio, linea por linea, contra el catalogo:
//
//   Pacamara — Q120
//   2x Bourbon — Q240
//   Cafetera italiana — Q200
//   Envío — Q45
//   *TOTAL: Q605*
//
// Que revisa:
//   1. Si menciona una cuenta bancaria, tiene que ser la oficial.
//   2. Cada linea "producto — Qmonto" contra su precio de catalogo.
//   3. El envio, si aparece, tiene que ser Q45 (una sola vez).
//   4. El TOTAL, si aparece, tiene que ser la suma de las lineas de arriba.
//
// Un mensaje SIN ninguna linea "algo — Qmonto" no tiene desglose que
// revisar: es charla o una explicacion de precios, y pasa tal cual. Eso es
// lo que arreglo el segundo bug del 1-9: "Con prensa serían Q445" (una
// frase suelta, sin tabla) ya no se toca.
//
// Que hace si falla: si el numero equivocado se puede identificar sin
// ambiguedad, se corrige EN EL MISMO MENSAJE —se cambia solo esa cifra, se
// conserva todo lo demas tal como lo escribio el modelo—. Si no se puede
// corregir con certeza (una cuenta bancaria ajena, un envio repetido), el
// mensaje NO se manda tal cual con el error: quien llama decide pasarlo a
// una persona. Y siempre queda el aviso en los logs.
// ===========================================================================

import { ACCESORIOS, ENVIO, sinAcentos } from './enforce-totales'
import { buscaCombo, buscaVariedad } from './carrito'

export const CUENTA_OFICIAL = '30-3093873-2'

/**
 * Deja el mensaje con el formato que WhatsApp entiende.
 *
 * El modelo escribe Markdown normal (**negrita**), pero WhatsApp usa UN solo
 * asterisco. Resultado: al cliente le llegaban los asteriscos a la vista
 * ("**Resumen:**") y, lo grave, PEGADOS AL LINK DE PAGO:
 *
 *   **https://sp.pagalo.co/kaffeejager-roastery**
 *
 * Con esos asteriscos la direccion deja de funcionar al tocarla, y el cliente
 * que iba a pagar no puede. Un link roto es una venta perdida.
 */
export function formatoWhatsApp(texto: string): string {
  if (!texto) return texto
  let t = texto
  // 1. Un enlace envuelto en negrita pierde la negrita entera: un link no
  //    necesita resaltarse y las marcas lo rompen.
  t = t.replace(/\*{1,2}\s*(https?:\/\/[^\s*_~`]+)\s*\*{1,2}/g, '$1')
  // 2. Negrita de Markdown -> negrita de WhatsApp.
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
  // 3. Cualquier marca que haya quedado pegada a un enlace.
  t = t.replace(/(https?:\/\/[^\s*_~`]+)[*_~`]+/g, '$1')
  // 4. Dobles sueltos que quedaron sin pareja.
  t = t.replace(/\*\*/g, '*')
  return t
}

export interface Veredicto {
  ok: boolean
  motivo?: string
  /**
   * El mensaje original con la UNICA cifra equivocada corregida. Solo viene
   * cuando el error se pudo identificar sin ambiguedad. Si `ok` es false y
   * `corregido` no viene, el error existe pero no es seguro repararlo solo:
   * hay que mandar el mensaje a una persona.
   */
  corregido?: string
}

/** Una linea "(cantidad)? descripcion — Qmonto" del mensaje. */
const RE_LINEA =
  /^[ \t]*(?:(\d{1,2})x[ \t]+)?([^\n—]+?)[ \t]+—[ \t]+Q[ \t]*(\d{1,6})[ \t]*\*?[ \t]*$/gim

/** La linea "*TOTAL: Qmonto*", la primera que aparezca. */
const RE_TOTAL = /total\s*(?:a\s*(?:pagar|transferir))?\s*[:=]?\s*\**\s*Q[ \t]*(\d{1,6})/i

interface LineaEncontrada {
  /** null = producto que el catalogo no reconoce; no se juzga su precio. */
  esperado: number | null
  monto: number
  inicio: number
  fin: number
  esEnvio: boolean
}

/**
 * Donde cae, dentro del texto completo, el monto que capturo un match.
 *
 * El monto es el ultimo numero del match (nada numerico lo sigue salvo
 * espacios/asterisco de cierre), asi que basta ubicar su ULTIMA aparicion
 * dentro del match para no confundirlo con un numero que traiga la
 * descripcion (una "Kenia SL28", por ejemplo).
 */
function posicionDelMonto(m: RegExpExecArray, grupo: string): [number, number] {
  const offset = m[0].lastIndexOf(grupo)
  const inicio = m.index + offset
  return [inicio, inicio + grupo.length]
}

/** Que combo (y con que accesorio) nombra esta descripcion, si nombra uno. */
function comboDeLinea(descripcionPlana: string): { unitario: number } | null {
  let base = descripcionPlana
  let accesorio: 'prensa' | 'cafetera' | null = null
  const conAccesorio = base.match(/^(.*?)\s+con\s+(prensa\s*francesa|cafetera\s*italiana)$/)
  if (conAccesorio) {
    base = conAccesorio[1].trim()
    accesorio = conAccesorio[2].startsWith('prensa') ? 'prensa' : 'cafetera'
  }
  const combo = buscaCombo(base)
  if (!combo) return null
  const unitario = accesorio === 'prensa' ? combo.prensa : accesorio === 'cafetera' ? combo.cafetera : combo.solo
  return { unitario }
}

/** Lee todas las lineas "algo — Qmonto" del mensaje y las juzga contra el catalogo. */
function leerLineas(texto: string): LineaEncontrada[] {
  const out: LineaEncontrada[] = []
  RE_LINEA.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RE_LINEA.exec(texto)) !== null) {
    const cantidad = m[1] ? Number(m[1]) : 1
    const descripcion = m[2].trim()
    const plano = sinAcentos(descripcion).trim()
    const monto = Number(m[3])
    const [inicio, fin] = posicionDelMonto(m, m[3])

    if (plano === 'envio' || plano === 'envío') {
      out.push({ esperado: ENVIO, monto, inicio, fin, esEnvio: true })
      continue
    }
    // Linea que es SOLO el accesorio (prensa o cafetera comprada suelta,
    // junto a bolsas): "Cafetera italiana — Q200". Este es exactamente el
    // caso que el 1-9 el carrito perdia.
    if (plano === 'prensa francesa' || plano === 'prensa') {
      out.push({ esperado: ACCESORIOS.prensa * cantidad, monto, inicio, fin, esEnvio: false })
      continue
    }
    if (plano === 'cafetera italiana' || plano === 'cafetera') {
      out.push({ esperado: ACCESORIOS.cafetera * cantidad, monto, inicio, fin, esEnvio: false })
      continue
    }
    const combo = comboDeLinea(plano)
    if (combo) {
      out.push({ esperado: combo.unitario * cantidad, monto, inicio, fin, esEnvio: false })
      continue
    }
    const variedad = buscaVariedad(plano)
    if (variedad) {
      out.push({ esperado: variedad[1] * cantidad, monto, inicio, fin, esEnvio: false })
      continue
    }
    // Producto que el catalogo no conoce (una promo, algo nuevo). No se
    // juzga esta linea, pero SI cuenta para el total de mas abajo: negarle
    // eso al mensaje bloquearia cualquier cosa que no este en la tabla.
    out.push({ esperado: null, monto, inicio, fin, esEnvio: false })
  }
  return out
}

/** Cambia solo los digitos en texto[inicio,fin) por el numero correcto. */
function conNumeroCorregido(texto: string, inicio: number, fin: number, valor: number): string {
  return texto.slice(0, inicio) + String(valor) + texto.slice(fin)
}

/**
 * Revisa el mensaje contra el catalogo. No necesita ningun carrito: verifica
 * el desglose que EL PROPIO MENSAJE escribio.
 */
export function revisarSalida(texto: string): Veredicto {
  if (!texto) return { ok: true }

  // 1. La cuenta bancaria: siempre, tenga desglose o no.
  const hablaDeCuenta = /\b(cuenta|cta\.?|monetaria|transferencia)\b/i.test(texto)
  const tieneOtraCuenta =
    hablaDeCuenta && /\b\d{2}-?\d{7}-?\d\b/.test(texto) && !texto.includes(CUENTA_OFICIAL)
  if (tieneOtraCuenta) {
    // Que cuenta poner en su lugar no es cosa de adivinar: se manda tal cual
    // esta y que lo revise una persona.
    return { ok: false, motivo: 'menciona una cuenta que no es la oficial' }
  }

  // 2. Lineas del desglose. Sin ninguna, no hay nada que revisar: es charla
  // o una explicacion de precios ("Con prensa serían Q445"), no un cobro.
  const lineas = leerLineas(texto)
  if (lineas.length === 0) return { ok: true }

  // 3. El envio, si aparece, tiene que ser Q45 y una sola vez.
  const envios = lineas.filter((l) => l.esEnvio)
  if (envios.length > 1) {
    return { ok: false, motivo: 'el envío aparece más de una vez' }
  }

  // 4. Cada linea reconocida contra su precio de catalogo. La primera que
  // no cuadre se corrige ahi mismo: un solo numero, el resto del mensaje
  // queda intacto.
  for (const l of lineas) {
    if (l.esperado !== null && l.monto !== l.esperado) {
      return {
        ok: false,
        motivo: `una línea dice Q${l.monto} y el catálogo son Q${l.esperado}`,
        corregido: conNumeroCorregido(texto, l.inicio, l.fin, l.esperado),
      }
    }
  }

  // 5. El TOTAL, si el mensaje lo afirma, tiene que ser la suma de arriba
  // (incluye las lineas que el catalogo no reconoce: se cuentan con el
  // monto que el mensaje ya les puso, no se inventan).
  const suma = lineas.reduce((acc, l) => acc + l.monto, 0)
  RE_TOTAL.lastIndex = 0
  const mTotal = RE_TOTAL.exec(texto)
  if (!mTotal) return { ok: true }
  const totalAfirmado = Number(mTotal[1])
  if (totalAfirmado === suma) return { ok: true }

  const [inicio, fin] = posicionDelMonto(mTotal, mTotal[1])
  return {
    ok: false,
    motivo: `el mensaje dice Q${totalAfirmado} y la suma del desglose son Q${suma}`,
    corregido: conNumeroCorregido(texto, inicio, fin, suma),
  }
}
