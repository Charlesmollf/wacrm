// ============================================================
// Catalogo de precios (datos).
//
// Hasta el 24-09 este archivo tambien tenia el "candado de precios"
// (enforceTotales / enforceAccesorios / enforceTotalGuardado), que
// reescribia los totales del bot. Se hizo para Haiku y termino cambiando
// cuentas que estaban bien (Alfredo, Yuls, Luis). Con Sonnet 5 se quito:
// aqui solo queda el catalogo, que usan el carrito, la caja, el cierre del
// pedido y los margenes.
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
   * minuscula). El combo trae siempre estas — si el cliente las cambia,
   * ya no es combo: se cobra como bolsas sueltas. Sirve para que `carrito.ts` sepa que un combo y sus propias
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
