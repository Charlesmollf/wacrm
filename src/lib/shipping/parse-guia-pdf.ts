import { inflateSync, inflateRawSync, gunzipSync } from 'zlib'

/**
 * Lee el PDF de guia que Cargo Expreso genera y que la tostaduria reenvia
 * al numero de la API.
 *
 * El PDF NO es un escaneo: trae el texto como cadenas hexadecimales dentro
 * de un content stream comprimido con Flate, con fuentes Helvetica
 * estandar. Por eso no hace falta OCR ni ninguna dependencia nueva — el
 * `zlib` de Node alcanza.
 *
 * Verificado contra la guia real A417513188-1 (5.5 KB): el unico contenido
 * binario son los dos logos; todo lo demas es texto.
 *
 * Si Cargo Expreso cambia el formato de la guia esto deja de encontrar los
 * campos. Devuelve null en vez de inventar: el llamador avisa y deja el
 * hueco, que es la regla de la fase de envios.
 */

export interface GuiaPdf {
  /** Numero de guia, ej. "A417513188-1". */
  guia: string
  /** Nombre del destinatario tal como sale impreso. */
  destinatario: string
  /**
   * Telefono del destinatario ya normalizado, ej. "50230230524". Null
   * cuando el campo no se pudo leer con certeza (ver `normalizarTelefono`):
   * el llamador cae al respaldo por nombre en vez de tirar toda la guia.
   */
  telefono: string | null
  /**
   * Lo que la tostaduria escribio en "Referencia 1" (el producto). Sirve
   * para distinguir la guia de una recompra de la de un envio viejo del
   * mismo cliente. Ojo: NO es confiable como identificador — a veces
   * viene mal escrito (en una guia real decia solo "cafetera italiana"),
   * asi que solo se usa para descartar, nunca para exigir.
   */
  producto: string | null
  /** Los textos crudos, para poder explicar por que algo no calzo. */
  textos: string[]
}

/** Descomprime un stream de PDF probando los tres sabores de Flate. */
function inflar(bytes: Buffer): string | null {
  for (const fn of [inflateSync, inflateRawSync, gunzipSync]) {
    try {
      return fn(bytes).toString('latin1')
    } catch {
      // Siguiente sabor. Un stream de imagen tambien cae aca y se ignora.
    }
  }
  return null
}

/**
 * Saca los textos de los operadores `Tj` del PDF, en el orden en que
 * aparecen impresos.
 *
 * Los toma en hex (`<4B61...> Tj`) y tambien entre parentesis
 * (`(texto) Tj`), porque no todos los generadores usan el mismo.
 */
export function extraerTextos(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1')
  const textos: string[] = []

  let desde = 0
  for (;;) {
    const ini = raw.indexOf('stream', desde)
    if (ini < 0) break

    let arranca = ini + 'stream'.length
    if (raw[arranca] === '\r') arranca++
    if (raw[arranca] === '\n') arranca++

    // El largo SIEMPRE sale del /Length del diccionario, nunca de buscar
    // "endstream": esa secuencia de bytes aparece por casualidad dentro de
    // los streams de imagen y corta el stream a la mitad. Probado: con
    // "endstream" el parser sacaba 0 textos de una guia real.
    const dic = raw.slice(Math.max(0, ini - 400), ini)
    const mLargo = dic.match(/\/Length\s+(\d+)[^\d]*$/)
    if (!mLargo) {
      desde = ini + 'stream'.length
      continue
    }
    const largo = parseInt(mLargo[1], 10)
    desde = arranca + largo

    const contenido = inflar(pdf.subarray(arranca, arranca + largo))
    if (!contenido) continue

    // Hex: <4B6166...> Tj
    for (const m of contenido.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      const hex = m[1]
      let s = ''
      for (let i = 0; i + 1 < hex.length; i += 2) {
        s += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
      }
      if (s.trim()) textos.push(s.trim())
    }

    // Parentesis: (texto) Tj
    for (const m of contenido.matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)) {
      const s = m[1].replace(/\\([()\\])/g, '$1').trim()
      if (s) textos.push(s)
    }
  }

  return textos
}

/**
 * Normaliza un telefono guatemalteco al formato que usa el CRM: 502 +
 * 8 digitos. La guia lo imprime como "3023-0524"; en `contacts.phone`
 * esta como "50230230524".
 *
 * Devuelve null si no son 8 digitos: preferimos no emparejar a emparejar
 * mal.
 */
export function normalizarTelefono(crudo: string): string | null {
  const soloDigitos = String(crudo ?? '').replace(/\D/g, '')
  if (soloDigitos.length === 8) {
    // Guias reales de sept/2026 (Yefer Alvarado y otros 7 el mismo dia)
    // trajeron el campo de telefono CORTADO a 8 caracteres cuando en
    // realidad el numero completo llevaba el codigo de pais (11
    // digitos): quedaba "502" + los primeros 5 digitos del numero real,
    // perdiendo los ultimos 3. Si a ESO se le antepone otro "502" (como
    // haria un numero local normal de 8 digitos) sale un telefono de 11
    // digitos que arranca "502502..." — no existe cliente con ese
    // numero, es el sintoma del corte. Mejor avisar que no se pudo leer
    // que mandar a alguien detras de un telefono que no es de nadie.
    if (soloDigitos.startsWith('502')) return null
    return `502${soloDigitos}`
  }
  if (soloDigitos.length === 11 && soloDigitos.startsWith('502')) return soloDigitos
  return null
}

/**
 * Numero de guia de Cargo Expreso.
 *
 * La forma normal es letra + digitos + guion + digito (A417513188-1), pero
 * los envios A AGENCIA traen ademas una letra pegada al final de los
 * digitos: A417470433A-1. Con el patron viejo esa guia no se reconocia y
 * el envio de Elisa Huinac se quedo sin numero en la hoja.
 *
 * Probado contra las 11 guias reales recibidas y contra los demas textos
 * del PDF (AACA, XLA, AXL1, GUA10, 1/1, 24-8-2026, 4531-6000...), que no
 * deben confundirse con una guia.
 */
const RE_GUIA = /^[A-Z]{1,2}\d{6,}[A-Z]{0,2}-\d{1,3}$/

export function parseGuiaPdf(pdf: Buffer): GuiaPdf | null {
  const textos = extraerTextos(pdf)
  if (textos.length === 0) return null

  const guia = textos.find((t) => RE_GUIA.test(t))
  if (!guia) return null

  // El destinatario y su telefono van cada uno DESPUES de su etiqueta.
  // Se busca por etiqueta y no por posicion fija: si Cargo Expreso mueve
  // un campo de lugar, esto sigue funcionando.
  const despuesDe = (etiqueta: RegExp): string | null => {
    const i = textos.findIndex((t) => etiqueta.test(t))
    if (i < 0 || i + 1 >= textos.length) return null
    return textos[i + 1]
  }

  const destinatario = despuesDe(/^Nombre\s+Destinatario$/i) ?? ''

  // Ojo: hay dos telefonos en la guia — el del remitente (la tostaduria)
  // y el del destinatario. En el PDF real el del remitente sale sin
  // tilde ("Telefono") y el del cliente con tilde ("Teléfono"). No nos
  // apoyamos en eso: tomamos el que viene DESPUES del destinatario.
  const iDest = textos.findIndex((t) => /^Nombre\s+Destinatario$/i.test(t))
  let telefono: string | null = null
  if (iDest >= 0) {
    for (let i = iDest; i < textos.length; i++) {
      if (!/^Tel[eé]fono$/i.test(textos[i])) continue
      telefono = normalizarTelefono(textos[i + 1] ?? '')
      if (telefono) break
    }
  }

  // Sin destinatario no hay ni a quien buscar por nombre: ahi si no hay
  // nada que hacer. Sin telefono todavia se puede intentar por nombre
  // (ver match-guia.ts), asi que eso solo NO tira el parseo entero.
  if (!destinatario) return null

  const producto = despuesDe(/^Referencia\s*1$/i)

  return { guia, destinatario, telefono, producto, textos }
}

/** Texto comparable: sin fecha, sin acentos, sin puntuacion. */
function normalizarProducto(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Palabras que no distinguen un producto de otro. */
const RUIDO = new Set(['de', 'con', 'y', 'sin', 'accesorio', 'la', 'el', 'gr', '400'])

function tokensProducto(s: string): Set<string> {
  return new Set(
    normalizarProducto(s)
      .split(' ')
      .filter((w) => w.length > 2 && !RUIDO.has(w)),
  )
}

function similitud(a: string, b: string): number {
  const A = tokensProducto(a)
  const B = tokensProducto(b)
  if (A.size === 0 || B.size === 0) return 0
  let comunes = 0
  for (const t of A) if (B.has(t)) comunes++
  return comunes / Math.max(A.size, B.size)
}

export type VerificacionProducto = 'ok' | 'guia-de-otra-venta' | 'sin-datos'

/**
 * ¿La guia corresponde a la venta ACTUAL del pedido, o a una anterior?
 *
 * El CRM reusa el mismo deal cuando un cliente recompra, asi que su
 * `combo_history` acumula varias ventas. Sin esto, la guia de un envio
 * viejo se pegaba al pedido nuevo: a Chin Chen Liu se le mando la guia de
 * su Gesha + Kenia cuando ya habia pedido un Colosos de America.
 *
 * Solo se bloquea con evidencia POSITIVA — que el producto del PDF se
 * parezca claramente mas a una venta anterior que a la actual. Si no se
 * parece a ninguna NO se bloquea, porque la tostaduria a veces escribe
 * mal esa referencia (una guia real traia solo "cafetera italiana") y
 * frenar por eso dejaria pedidos buenos sin numero.
 */
export function verificarProducto(
  productoPdf: string | null | undefined,
  comboHistory: string | null | undefined,
): VerificacionProducto {
  if (!productoPdf || !comboHistory) return 'sin-datos'

  const lineas = String(comboHistory)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  // Una sola venta: no hay con que confundirse.
  if (lineas.length < 2) return 'ok'

  const simUltima = similitud(productoPdf, lineas[lineas.length - 1])
  let mejorAnterior = 0
  for (let i = 0; i < lineas.length - 1; i++) {
    mejorAnterior = Math.max(mejorAnterior, similitud(productoPdf, lineas[i]))
  }

  if (mejorAnterior >= 0.6 && mejorAnterior > simUltima) return 'guia-de-otra-venta'
  return 'ok'
}
