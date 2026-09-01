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
// Reglas:
//   - El carrito se REEMPLAZA completo, nunca se ajusta. Agregar o quitar algo
//     produce un carrito nuevo y el total se recalcula desde cero.
//   - `combo_history` no se toca: sigue siendo el historial de compras del
//     cliente. Las dos formas conviven y el carrito manda cuando existe.
// ===========================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ItemPedido, Accesorio, Desglose } from './caja'
import { calcularPedido } from './caja'
import { CATALOGO, VARIEDADES, sinAcentos } from './enforce-totales'

export interface Carrito {
  items: ItemPedido[]
  accesorioSuelto: Accesorio
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
  const obj = c as { items?: unknown; accesorioSuelto?: unknown }
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
  }
}

/**
 * Traduce una descripcion de pedido al carrito, para los pedidos que vienen
 * del formato viejo o de la marca que manda el bot.
 *
 * Devuelve null cuando no reconoce nada: en ese caso se sigue como antes en
 * vez de inventar un pedido.
 */
export function carritoDesdeTexto(texto: string | null | undefined): Carrito | null {
  const plano = sinAcentos(String(texto ?? '')).replace(/^\[[^\]]*\]\s*/, '')
  if (!plano.trim()) return null

  const accesorioSuelto: Accesorio = /prensa\s*francesa/.test(plano)
    ? 'prensa'
    : /cafetera\s*italiana|moka/.test(plano)
      ? 'cafetera'
      : 'ninguno'

  // La cartera importada de Kommo escribe los nombres pegados y con la
  // cantidad delante: "01ColososAmerica", "02MiticoCoban". Comparar sin
  // espacios ni signos hace que esos entren igual que "Colosos de America".
  const compacto = plano.replace(/[^a-z0-9]/g, '')

  // Un combo con nombre gana sobre las bolsas: su precio ya incluye el
  // accesorio y no se suma aparte.
  const combo = CATALOGO.find((c) =>
    c.claves.some((k) => {
      const kc = sinAcentos(k).replace(/[^a-z0-9]/g, '')
      return plano.includes(k) || (kc.length >= 5 && compacto.includes(kc))
    }),
  )
  if (combo) {
    return {
      items: [
        {
          tipo: 'combo',
          nombre: combo.nombre,
          cantidad: cuantasUnidades(plano),
          accesorio: accesorioSuelto,
        },
      ],
      accesorioSuelto: 'ninguno',
    }
  }

  // Bolsas sueltas: se parte por "+" o coma y se cuenta cada trozo aparte, de
  // modo que un producto nombrado dos veces en la misma frase no se duplique.
  // La cartera de Kommo trae "Kennia" con doble n. Es Kenia SL28, y cuesta
  // Q200: sin esto se cobraba como una bolsa comun.
  const conAlias = plano.replace(/kennia/g, 'kenia sl28')
  const trozos = conAlias.split(/[+,\n]/).map((s) => s.trim()).filter(Boolean)
  const porNombre = new Map<string, number>()
  for (const trozo of trozos) {
    const trozoCompacto = trozo.replace(/[^a-z0-9]/g, '')
    const variedad = VARIEDADES.find(([n]) => {
      const nn = sinAcentos(n)
      return trozo.includes(nn) || trozoCompacto.includes(nn.replace(/[^a-z0-9]/g, ''))
    })
    if (!variedad) continue
    const nombre = variedad[0]
    const cantidad = cuantasUnidades(trozo)
    porNombre.set(nombre, (porNombre.get(nombre) ?? 0) + cantidad)
  }
  if (porNombre.size === 0) return null

  return {
    items: [...porNombre].map(([nombre, cantidad]) => ({
      tipo: 'bolsa' as const,
      nombre,
      cantidad,
    })),
    accesorioSuelto,
  }
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

/**
 * El desglose del pedido en curso, o null si no hay carrito ni se pudo
 * reconstruir del historial. Null significa "seguir como antes".
 */
export function desgloseDelPedido(
  fila: { carrito?: unknown; combo_history?: string | null } | null | undefined,
): Desglose | null {
  const carrito = leerCarrito(fila) ?? carritoDesdeTexto(ultimaLinea(fila?.combo_history))
  if (!carrito || carrito.items.length === 0) return null
  try {
    return calcularPedido(carrito.items, carrito.accesorioSuelto)
  } catch (err) {
    // Un producto fuera de catalogo no puede tumbar la respuesta al cliente.
    console.warn('[carrito] no se pudo calcular:', err instanceof Error ? err.message : err)
    return null
  }
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
