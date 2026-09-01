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
// Que revisa:
//   1. Si el mensaje afirma un TOTAL, tiene que ser el de la caja.
//   2. Si menciona una cuenta bancaria, tiene que ser la oficial.
//   3. Ninguna cifra en quetzales puede estar fuera del desglose calculado.
//
// Que hace si falla: NO se le pide al modelo que lo intente de nuevo (volveria
// a inventar). El codigo arma el mensaje correcto con la plantilla y manda ese.
// Y queda el aviso en los logs, porque un modelo intentando inventar un numero
// es sintoma de que algo esta mal mas arriba.
// ===========================================================================

import type { Desglose } from './caja'
import { textoDelDesglose } from './caja'

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
  /** Cifras del mensaje que no corresponden a ningun monto del pedido. */
  cifrasRaras?: number[]
}

/** Todos los montos que el mensaje tiene permitido nombrar. */
function montosPermitidos(d: Desglose): Set<number> {
  const ok = new Set<number>([d.total, d.cafe, d.envio])
  for (const l of d.lineas) {
    ok.add(l.total)
    ok.add(l.unitario)
  }
  // Un pedido de varias lineas puede nombrar subtotales parciales legitimos
  // ("las dos bolsas son Q240"), asi que se permiten las sumas acumuladas.
  let acumulado = 0
  for (const l of d.lineas) {
    acumulado += l.total
    ok.add(acumulado)
    ok.add(acumulado + d.envio)
  }
  return ok
}

/** Cifras en quetzales que aparecen en el texto. */
function cifrasDelTexto(texto: string): number[] {
  const out: number[] = []
  const re = /Q\s*(\d{2,5})(?![\d/-])/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(texto)) !== null) out.push(Number(m[1]))
  return out
}

/** El total que el mensaje afirma, si lo afirma. */
export function totalAfirmado(texto: string): number | null {
  const re = /total\s*(?:a\s*(?:pagar|transferir))?\s*[:=]?\s*\**\s*Q\s*(\d{2,5})/i
  const m = texto.match(re)
  if (m) return Number(m[1])
  const igual = texto.match(/=\s*\**\s*Q\s*(\d{2,5})\s*\**\s*total/i)
  return igual ? Number(igual[1]) : null
}

/**
 * Revisa el mensaje contra el pedido calculado.
 *
 * `desglose` es null cuando todavia no hay un pedido armado (el cliente esta
 * preguntando precios). En ese caso solo se revisa la cuenta bancaria: no hay
 * contra que comparar las cifras y bloquear seria romper una consulta normal.
 */
export function revisarSalida(texto: string, desglose: Desglose | null): Veredicto {
  if (!texto) return { ok: true }

  // 1. La cuenta bancaria: siempre, haya pedido o no.
  const hablaDeCuenta = /\b(cuenta|cta\.?|monetaria|transferencia)\b/i.test(texto)
  const tieneOtraCuenta =
    hablaDeCuenta &&
    /\b\d{2}-?\d{7}-?\d\b/.test(texto) &&
    !texto.includes(CUENTA_OFICIAL)
  if (tieneOtraCuenta) {
    return { ok: false, motivo: 'menciona una cuenta que no es la oficial' }
  }

  if (!desglose || desglose.lineas.length === 0) return { ok: true }

  // 2. El total afirmado tiene que ser el de la caja.
  const afirmado = totalAfirmado(texto)
  if (afirmado !== null && afirmado !== desglose.total) {
    return {
      ok: false,
      motivo: `el mensaje dice Q${afirmado} y el pedido son Q${desglose.total}`,
    }
  }

  // 3. Ninguna cifra puede estar fuera del desglose.
  const permitidos = montosPermitidos(desglose)
  const raras = cifrasDelTexto(texto).filter((c) => !permitidos.has(c))
  if (raras.length > 0) {
    return {
      ok: false,
      motivo: `cifras que no salen del pedido: ${raras.join(', ')}`,
      cifrasRaras: raras,
    }
  }

  return { ok: true }
}

/**
 * La parte conversacional del mensaje: lo que el modelo escribio ANTES de
 * empezar a dar numeros.
 *
 * Sirve para que, cuando el portero frena un mensaje, al cliente no le llegue
 * una tabla seca: se conserva el saludo y el reconocimiento ("Perfecto, se lo
 * preparo en molido") y solo se reemplaza la cuenta.
 */
export function parteConversacional(texto: string): string {
  const lineas = texto.split('\n')
  const buenas: string[] = []
  for (const linea of lineas) {
    // En cuanto aparece una cifra en quetzales empieza la cuenta: ahi se corta.
    if (/Q\s*\d{2,5}/i.test(linea)) break
    buenas.push(linea)
  }
  const limpio = buenas.join('\n').trim()
  // Una frase suelta muy corta ("Perfecto") no aporta; mejor el texto propio.
  return limpio.length >= 8 ? limpio : ''
}

/**
 * El mensaje que sale cuando el portero rechaza.
 *
 * El desglose viene de la caja y no lo toca nadie. Lo conversacional se
 * conserva del modelo cuando existe, para que el cliente no reciba un cuadro
 * seco despues de una conversacion normal.
 */
export function mensajeDeRespaldo(d: Desglose, textoOriginal?: string): string {
  const saludo = textoOriginal ? parteConversacional(textoOriginal) : ''
  const cuenta = textoDelDesglose(d)
  if (saludo) return `${saludo}\n\n${cuenta}`
  return `Le confirmo su pedido:\n\n${cuenta}`
}
