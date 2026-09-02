// ============================================================
// Candado de precios.
//
// El prompt YA dice los precios correctos y hasta advierte "nunca sumes
// el envio dos veces". El bot igual lo rompio con clientas reales:
//
//   1) A Luisa le cotizo bien "Q500 + Q45 = Q545" y dos mensajes
//      despues repitio "Q545 + Q45 = Q590", cobrando el envio dos
//      veces. Peor: Q590 es el total legitimo de Africa Mia CON
//      CAFETERA, asi que la tostaduria leyo el monto y le armo la caja
//      con cafetera cuando habia pedido prensa.
//
//   2) A la Dra. Flor le cobro 6 bolsas donde habia 5: Q720 + Q45 =
//      Q765 en vez de Q600 + Q45 = Q645. La aritmetica estaba bien;
//      la cantidad no. Hubo que devolverle el dinero.
//
// Por eso los precios dejan de ser una instruccion de prompt y pasan a
// ser un candado de codigo, igual que `enforceBankAccount`.
//
// REGLA DE ORO: ante la duda NO se toca el mensaje. Solo se corrige
// cuando la cuenta se puede reconstruir sin ambiguedad; si el mensaje
// esta listando las tres opciones de precio (que es lo que el prompt
// pide al explicar un combo) se deja intacto.
// ============================================================

export const ENVIO = 45

export interface Combo {
  /** Nombre tal cual se le muestra al cliente. */
  nombre: string
  claves: string[]
  solo: number
  prensa: number
  cafetera: number
  /**
   * Variedades FIJAS que trae el combo (claves de `VARIEDADES`, en
   * minuscula). El cliente no las elige ni las cambia — vienen todas
   * siempre. Sirve para que `carrito.ts` sepa que un combo y sus propias
   * variedades no son dos cosas distintas: ver el comentario grande en
   * ese archivo sobre el bug del 2 de septiembre.
   */
  contenido?: string[]
}

/** Precios del cafe SIN envio. Fuente: MANUAL.md seccion 2. */
export const CATALOGO: Combo[] = [
    { nombre: 'Procesos Secretos', claves: ['procesos secretos'], solo: 240, prensa: 260, cafetera: 440, contenido: ['anaerobico', 'peaberry'] },
  { nombre: 'Colosos de América', claves: ['colosos de america', 'colosos'], solo: 345, prensa: 445, cafetera: 545, contenido: ['pacamara', 'maracaturra', 'maragogipe'] },
  { nombre: 'Intensa Dulzura', claves: ['intensa dulzura'], solo: 345, prensa: 445, cafetera: 545, contenido: ['pacamara', 'catuai', 'anaerobico'] },
  { nombre: 'Mítico Cobán', claves: ['mitico coban'], solo: 345, prensa: 445, cafetera: 545, contenido: ['bourbon', 'catuai', 'caturra roja'] },
  { nombre: 'África Mía', claves: ['africa mia'], solo: 400, prensa: 500, cafetera: 545, contenido: ['gesha', 'kenia sl28'] },
  // Highland Cobán: el prompt no dice su contenido fijo, se deja sin `contenido`.
  { nombre: 'Highland Cobán', claves: ['highland coban', 'combo #4'], solo: 220, prensa: 320, cafetera: 440 },
]

/**
 * Bolsas de 400gr sueltas. Q120 todas menos las premium (Q200).
 * El orden importa: las claves largas van primero para que
 * "kenia sl28" gane sobre "kenia" y "caturra roja" sobre "caturra".
 */
export const VARIEDADES: [string, number][] = [
  ['caturra roja', 120],
  ['kenia sl28', 200],
  ['bourbon', 120],
  ['catuai', 120],
  ['caturra', 120],
  ['pacamara', 120],
  ['maracaturra', 120],
  ['maragogipe', 120],
  ['peaberry', 120],
  ['caracolillo', 120],
  ['anaerobico', 120],
  ['cardamomo', 120],
  ['gesha', 200],
  ['geisha', 200],
  ['kenia', 200],
]

export const ACCESORIOS: Record<string, number> = { prensa: 100, cafetera: 200 }

export function sinAcentos(s: string): string {
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

/**
 * Cuenta bolsas sueltas. Cubre los dos formatos que usa el bot:
 * "2 Anaerobico + 1 Pacamara" y "Anaerobico + Anaerobico + Pacamara".
 * Devuelve null cuando no reconoce ninguna variedad.
 */
export function precioDeBolsas(plano: string): number | null {
  const trozos = plano.split(/[+,\n]/).map((s) => s.trim()).filter(Boolean)
  let cafe = 0
  let encontradas = 0
  for (const trozo of trozos) {
    for (const [nombre, precio] of VARIEDADES) {
      if (!trozo.includes(nombre)) continue
      const m = trozo.match(/(?:^|\D)(\d{1,2})\s*x?\s*(?=[a-z])/)
      const cant = m ? Number(m[1]) : 1
      cafe += precio * cant
      encontradas++
      break // una variedad por trozo
    }
  }
  return encontradas > 0 ? cafe : null
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
 * Precio del cafe (sin envio) que corresponde al pedido descrito en el
 * texto, o null cuando no se puede saber con certeza.
 *
 * Exportada porque el mismo calculo hace falta al GUARDAR el pedido
 * (`deal-updates.ts`), no solo al hablarle al cliente: el bot puede
 * decir el total correcto y aun asi escribir otro en la ficha.
 */
export function precioEsperadoDelCafe(texto: string): number | null {
  const plano = sinAcentos(texto)

  const combos = CATALOGO.filter((c) => c.claves.some((k) => plano.includes(k)))
  // Con varios combos el mensaje es informativo o comparativo.
  if (combos.length > 1) return null

  const acc = accesorioMencionado(plano)
  // Prensa y cafetera juntas es un pedido armado a mano: fuera de tabla.
  if (acc === 'ambos') return null

  if (combos.length === 1) {
    const c = combos[0]
    return acc === 'prensa' ? c.prensa : acc === 'cafetera' ? c.cafetera : c.solo
  }

  // Sin combo con nombre: puede ser un pedido de bolsas sueltas.
  const bolsas = precioDeBolsas(plano)
  if (bolsas === null) return null
  return acc === 'solo' ? bolsas : bolsas + ACCESORIOS[acc]
}

/**
 * Revisa el total de un mensaje de venta y lo corrige si no cuadra con
 * el catalogo. Devuelve el texto tal cual cuando no hay nada seguro que
 * corregir.
 */
export function enforceTotales(texto: string): string {
  if (!texto) return texto

  const cafe = precioEsperadoDelCafe(texto)
  if (cafe === null) return texto
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

/**
 * Valida el total que se va a GUARDAR en `deals.value` contra el
 * producto que se guarda junto a el. Devuelve el total corregido, o el
 * original cuando no se puede calcular con certeza.
 *
 * Existe porque el texto y la ficha se escriben por caminos distintos:
 * a Luisa el bot le dijo "Q545" en el chat y guardo 590 en el pedido.
 */
export function enforceTotalGuardado(
  combo: string | null | undefined,
  total: number | null | undefined,
): number | null | undefined {
  if (!combo || total === null || total === undefined) return total
  const cafe = precioEsperadoDelCafe(combo)
  if (cafe === null) return total
  return cafe + ENVIO
}


/**
 * REGLA DURA DEL ACCESORIO.
 *
 * Todo combo se vende de tres formas: solo, con prensa francesa o con
 * cafetera italiana. Si el bot cotiza un combo y NO dice las tres, el
 * cliente asume lo que vio en la foto del carrusel — donde la caja sale
 * con cafetera adentro. A Davies le cotizaron "Africa Mia Q400 +
 * Procesos Secretos Q240" sin nombrar accesorios y dio por hecho que
 * venian con cafetera y prensa. Se descubrio recien al preparar el
 * pedido.
 *
 * Igual que los precios, esto deja de ser una instruccion de prompt
 * (que el bot ignoro) y pasa a ser un candado de codigo.
 *
 * Solo actua cuando el mensaje esta COTIZANDO: nombra un combo del
 * catalogo Y pone un precio. No toca la charla suelta, ni el resumen
 * final del pedido, ni un mensaje que ya hable de accesorios.
 */
export function enforceAccesorios(texto: string): string {
  if (!texto) return texto
  const plano = sinAcentos(texto)

  // Ya habla de accesorios: el bot hizo su trabajo, no se toca.
  if (/prensa\s+francesa|cafetera\s+italiana|sin\s+accesorio/.test(plano)) {
    return texto
  }
  // Sin precio no esta cotizando, esta conversando.
  if (!/q\s*\d{2,4}/.test(plano)) return texto
  // El resumen final ya cerro el pedido: ahi agregar opciones confunde.
  if (/💵|molienda:/.test(plano)) return texto

  const combos = CATALOGO.filter((c) => c.claves.some((k) => plano.includes(k)))
  if (combos.length === 0) return texto

  // La aclaracion va UNA SOLA VEZ al final, no una por combo.
  //
  // Antes se agregaba una linea de tres precios por cada combo nombrado: en un
  // mensaje con cinco combos eran quince precios y quedaba un muro de texto
  // que nadie lee (le paso a "The Last Of The Moicain").
  //
  // Con UN combo el detalle sirve y es corto, asi que se deja. Con varios se
  // pone una sola linea sin precios: el recargo del accesorio NO es parejo
  // entre combos (Procesos Secretos con prensa sube Q20, Africa Mia con
  // cafetera sube Q145), asi que dar un "+Q100" generico seria mentir.
  if (combos.length === 1) {
    const c = combos[0]
    return (
      texto.trimEnd() +
      `\n\n¿Lo desea con accesorio? (precios sin envío; se suman Q${ENVIO} al total)\n` +
      `📌 *${c.nombre}*: solo Q${c.solo} · con prensa francesa Q${c.prensa} · con cafetera italiana Q${c.cafetera}`
    )
  }
  return (
    texto.trimEnd() +
    `\n\n☕ Cualquiera de estos combos puede llevar prensa francesa o cafetera italiana. ` +
    `Dígame cuál le interesa y le paso el precio exacto. (Los precios son sin envío; se suman Q${ENVIO}.)`
  )
}
