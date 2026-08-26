// ===========================================================================
// NUMEROS DE LA CASA
//
// La tostaduria manda las guias de Cargo Expreso al mismo numero por donde
// escriben los clientes. Sin esto, el bot les contestaria "¿en grano o
// molido?" a un PDF de envio, le llegaria al duenio una alerta de "este chat
// necesita un humano" por cada guia, y cada companero de trabajo terminaria
// contado como un lead en el tablero.
//
// Aca marcamos esos numeros. El mensaje se guarda igual (lo necesitamos para
// leer la guia), pero no dispara nada de lo que es para clientes.
// ===========================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Los ultimos 8 digitos: en Guatemala eso identifica al abonado. */
function ultimos8(phone: string): string {
  return String(phone ?? '').replace(/\D/g, '').slice(-8)
}

/**
 * ¿Este numero es de la casa?
 *
 * Se compara por los ultimos 8 digitos: el mismo
 * telefono llega escrito de mil formas (+502 3007 0821, 50230070821, 30070821)
 * y todas tienen que dar el mismo resultado.
 *
 * Ante cualquier error devuelve false: si la base falla, preferimos que el bot
 * conteste de mas a que deje a un cliente real esperando.
 */
export async function esNumeroInterno(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<boolean> {
  try {
    const clave = ultimos8(phone)
    if (!clave) return false
    const { data } = await db
      .from('internal_numbers')
      .select('phone, label')
      .eq('account_id', accountId)
    for (const fila of data ?? []) {
      if (ultimos8(String((fila as { phone: string }).phone)) === clave) {
        console.log(
          `[interno] mensaje de ${(fila as { label?: string }).label || phone}: el bot no contesta`,
        )
        return true
      }
    }
    return false
  } catch (err) {
    console.error('[interno] no se pudo revisar la lista:', err)
    return false
  }
}
