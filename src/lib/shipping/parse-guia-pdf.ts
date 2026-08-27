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
  /** Telefono del destinatario ya normalizado, ej. "50230230524". */
  telefono: string
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
  if (soloDigitos.length === 8) return `502${soloDigitos}`
  if (soloDigitos.length === 11 && soloDigitos.startsWith('502')) return soloDigitos
  return null
}

/** Un numero de guia de Cargo Expreso: letra + digitos + guion + digito. */
const RE_GUIA = /^[A-Z]\d{6,}-\d+$/

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

  if (!telefono || !destinatario) return null

  return { guia, destinatario, telefono, textos }
}
