import type { SupabaseClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { procesarGuiaPdf } from './match-guia'

/**
 * Punto de entrada desde el webhook de WhatsApp.
 *
 * La tostaduria manda al numero de la API el PDF de cada guia de Cargo
 * Expreso. Esto lo detecta, lo lee y escribe el numero de guia en la fila
 * del pedido.
 *
 * Solo corre para numeros de la casa (`internal_numbers`): un PDF que
 * manda un cliente nunca se toma como guia.
 *
 * Nunca lanza. Si algo falla, el mensaje ya quedo en la conversacion y la
 * guia se puede escribir a mano.
 */

export interface DispatchGuiaArgs {
  db: SupabaseClient
  accountId: string
  /** Dueno de la config de WhatsApp: va como user_id en las notificaciones. */
  userId: string
  /**
   * Si el que mando el PDF es un numero de la casa. El webhook ya lo
   * calculo con `esNumeroInterno`; se recibe hecho para no repetir la
   * consulta en cada mensaje.
   */
  esInterno: boolean
  /** El media id del documento en Meta. */
  mediaId: string
  mimeType?: string
  accessToken: string
}

export async function dispatchGuiaPdf(args: DispatchGuiaArgs): Promise<void> {
  const { db, accountId, userId, esInterno, mediaId, mimeType, accessToken } = args

  try {
    // Un PDF de un cliente nunca es una guia.
    if (!esInterno) return
    if (mimeType && !mimeType.includes('pdf')) return

    const { url } = await getMediaUrl({ mediaId, accessToken })
    const { buffer } = await downloadMedia({ downloadUrl: url, accessToken })

    const res = await procesarGuiaPdf(db, accountId, userId, buffer)
    if (!res.ok) {
      console.warn(`[guia] no se pudo emparejar: ${res.motivo}`)
    }
  } catch (err) {
    // A proposito no se re-lanza: un PDF raro no puede tumbar el webhook.
    console.error('[guia] fallo el procesamiento:', err)
  }
}
