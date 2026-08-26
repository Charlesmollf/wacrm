// ===========================================================================
// ARCHIVO DE IMAGENES DEL CHAT
//
// Meta guarda los archivos que manda el cliente unos 30 dias y despues los
// borra. Como en la base solo guardabamos el id de Meta, cada vez que abrias
// el chat el CRM se los pedia a Meta: pasado ese mes toda imagen quedaba rota
// para siempre, y mientras tanto cada vista gastaba una llamada a la API.
// Le paso a Rosaura Perez: mando "Quisiera este" con una foto y hoy no se ve.
//
// Aca bajamos el archivo UNA vez, al momento de recibirlo, y lo guardamos en
// Supabase Storage. El bucket es privado: las imagenes se siguen sirviendo por
// /api/whatsapp/media/<id>, que ya exige sesion y valida la cuenta.
//
// Todo es best-effort: si guardar falla, el mensaje se procesa igual y el
// visor cae a Meta como antes. Nunca se rompe una conversacion por una foto.
// ===========================================================================

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

const BUCKET = 'whatsapp-media'

/** Ruta dentro del bucket. Separada por cuenta para no mezclar negocios. */
function rutaDe(accountId: string, mediaId: string): string {
  return `${accountId}/${mediaId}`
}

/**
 * Baja el archivo de Meta y lo guarda. Devuelve true si quedo guardado.
 * Si ya existia no lo vuelve a bajar.
 */
export async function archivarMedia(args: {
  mediaId: string
  accessToken: string
  accountId: string
}): Promise<boolean> {
  const { mediaId, accessToken, accountId } = args
  if (!mediaId || !accountId) return false
  const ruta = rutaDe(accountId, mediaId)

  try {
    const almacen = supabaseAdmin().storage.from(BUCKET)

    // ¿Ya lo tenemos? Evita bajarlo dos veces cuando Meta reintenta el
    // webhook (manda el mismo mensaje hasta que le contestamos 200).
    const { data: existente } = await almacen.list(accountId, {
      search: mediaId,
      limit: 1,
    })
    if (existente && existente.length > 0) return true

    const info = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: info.url,
      accessToken,
    })

    const { error } = await almacen.upload(ruta, buffer, {
      contentType: contentType || info.mimeType || 'application/octet-stream',
      upsert: true,
    })
    if (error) {
      console.error(`[media-store] no se pudo guardar ${ruta}:`, error.message)
      return false
    }
    console.log(`[media-store] guardado ${ruta} (${buffer.length} bytes)`)
    return true
  } catch (err) {
    console.error(
      `[media-store] fallo al archivar ${mediaId}:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

/**
 * Lee el archivo ya guardado. Devuelve null si no lo tenemos, para que
 * quien llame pueda ir a Meta como antes.
 */
export async function leerMediaGuardada(args: {
  mediaId: string
  accountId: string
}): Promise<{ buffer: Buffer; contentType: string } | null> {
  const { mediaId, accountId } = args
  if (!mediaId || !accountId) return null
  try {
    const { data, error } = await supabaseAdmin()
      .storage.from(BUCKET)
      .download(rutaDe(accountId, mediaId))
    if (error || !data) return null
    const buffer = Buffer.from(await data.arrayBuffer())
    if (buffer.length === 0) return null
    return {
      buffer,
      contentType: data.type || 'application/octet-stream',
    }
  } catch {
    return null
  }
}
