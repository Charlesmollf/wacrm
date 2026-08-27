// ============================================================
// Candado de precios.
//
// El prompt YA dice los precios correctos y hasta advierte "nunca sumes
// el envio dos veces". El bot igual lo rompio con una clienta real: le
// cotizo bien "Q500 + Q45 = Q545" y dos mensajes despues repitio
// "Q545 + Q45 = Q590", cobrando el envio dos veces. Peor: Q590 es el
// total legitimo de Africa Mia CON CAFETERA, asi que la tostaduria leyo
// el monto y le armo la caja con cafetera cuando habia pedido prensa.
//
// Por eso los precios dejan de ser una instruccion de prompt y pasan a
// ser un candado de codigo, igual que `enforceBankAccount`.
//
// REGLA DE ORO: ante la duda NO se toca el mensaje. Solo se corrige
// cuando hay UN combo y UNA cuenta; si el mensaje esta listando las tres
// opciones de precio (que es lo que el prompt pide al explicar un combo)
// se deja intacto.
// ============================================================

const ENVIO = 45

interface Combo {
  claves: string[]
  solo: number
  prensa: number
  cafetera: number
}

/** Precios del cafe SIN envio. Fuente: MANUAL.md seccion 2. */
const CATALOGO: Combo[] = [
  { claves: ['procesos secretos'], solo: 240, prensa: 260, cafetera: 440 },
  { claves: ['colosos de america', 'colosos'], solo: 345, prensa: 445, cafetera: 545 },
  { claves: ['intensa dulzura'], solo: 345, prensa: 445, cafetera: 545 },
  { claves: ['mitico coban'], solo: 345, prensa: 445, cafetera: 545 },
  { claves: ['africa mia'], solo: 400, prensa: 500, cafetera: 545 },
  { claves: ['highland coban', 'combo #4'], solo: 220, prensa: 320, cafetera: 440 },
]

function sinAcentos(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

type Accesorio = 'solo' | 'prensa' | 'cafetera' | 'ambos'

function accesorioMencionado(plano: string): Accesorio {
  const prensa = /prensa\s+francesa/.test(plano)
  const cafetera = /cafetera\s+italiana|moka/.test(plano)
  if (prensa && cafetera) return 'ambos'
  if (prensa) return 'prensa'
  if (cafetera) return 'cafetera'
  return 'solo'
}

/** Totales que el mensaje afirma: "= Q590 total" o "total: Q590". */
function totalesAfirmados(texto: string) {
  const out: { index: number; texto: string; valor: number }[] = []
  const re =
    /(?:=\s*\**\s*Q\s*(\d{2,4})\s*\**\s*total|total\s*[:=]?\s*\**\s*Q\s*(\d{2,4}))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(texto)) !== null) {
    out.push({ index: m.index, texto: m[0], valor: Number(m[1] ?? m[2]) })
  }
  return out
}

/**
 * Revisa el total de un mensaje de venta y lo corrige si no cuadra con
 * el catalogo. Devuelve el texto tal cual cuando no hay nada seguro que
 * corregir.
 */
export function enforceTotales(texto: string): string {
  if (!texto) return texto
  const plano = sinAcentos(texto)

  const combos = CATALOGO.filter((c) => c.claves.some((k) => plano.includes(k)))
  // Con varios combos el mensaje es informativo o comparativo: no se toca.
  if (combos.length !== 1) return texto

  const acc = accesorioMencionado(plano)
  // Prensa y cafetera juntas es un pedido armado a mano: fuera del catalogo.
  if (acc === 'ambos') return texto

  const combo = combos[0]
  const cafe =
    acc === 'prensa' ? combo.prensa : acc === 'cafetera' ? combo.cafetera : combo.solo
  const esperado = cafe + ENVIO

  // Caso preferido: la formula completa "QA + Q45 envio = QB". Se
  // reescriben LOS DOS numeros; corregir solo el total dejaria el
  // mensaje diciendo un absurdo tipo "Q545 + Q45 = Q545".
  const reFormula =
    /Q\s*(\d{2,4})(\s*\**\s*\+\s*\**\s*Q\s*45\s*(?:de\s+)?env[ií]o\s*\**\s*=\s*\**\s*)Q\s*(\d{2,4})/gi
  const formulas = [...texto.matchAll(reFormula)]
  if (formulas.length === 1) {
    const f = formulas[0]
    if (Number(f[1]) === cafe && Number(f[3]) === esperado) return texto
    const reemplazo = `Q${cafe}${f[2]}Q${esperado}`
    const i = f.index ?? 0
    return texto.slice(0, i) + reemplazo + texto.slice(i + f[0].length)
  }
  // Varias formulas = comparativa de opciones: no se toca.
  if (formulas.length > 1) return texto

  const totales = totalesAfirmados(texto)
  if (totales.length !== 1) return texto

  const t = totales[0]
  if (t.valor === esperado) return texto

  const corregido = t.texto.replace(String(t.valor), String(esperado))
  return texto.slice(0, t.index) + corregido + texto.slice(t.index + t.texto.length)
}
