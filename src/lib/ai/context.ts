import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  id?: string | null
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: string | null
  media_url?: string | null
  reply_to_message_id?: string | null
}

/**
 * Nombre del producto a partir de la URL de la foto.
 *
 * Las fotos del catalogo salen del CDN de Shopify y el archivo se llama
 * como el producto, con guion bajo o pegado:
 *   .../files/Intensa_Dulzura.jpg?v=1738639250  ->  "Intensa Dulzura"
 *   .../files/ProcesosSecretos.jpg?v=1738639251 ->  "Procesos Secretos"
 *
 * Las fotos que manda el cliente vienen del CDN de WhatsApp con un
 * nombre que es un hash y no dice nada. Por eso solo se acepta lo que
 * parezca un nombre: al menos cuatro letras, y mas letras que otra
 * cosa. Ante la duda devuelve null — inventarle un nombre a una foto es
 * peor que no nombrarla.
 */
export function nombreDeFoto(url: string | null | undefined): string | null {
  if (!url) return null
  const archivo = url.split('?')[0].split('/').pop() ?? ''
  const base = archivo.replace(/\.(jpe?g|png|webp|gif|heic)$/i, '')
  const limpio = base
    .replace(/[_-]+/g, ' ')
    // "ProcesosSecretos" -> "Procesos Secretos"
    .replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (limpio.length < 4) return null
  const letras = (limpio.match(/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/g) ?? []).length
  if (letras < 4 || letras < limpio.length / 2) return null
  return limpio
}

/**
 * Como se ve un mensaje en el transcript que lee el modelo, o null si
 * no aporta nada y se descarta.
 */
function describir(m: DbMessage): string | null {
  const texto = m.content_text?.trim()
  if (texto) return texto

  if (!m.content_type || m.content_type === 'text') return null

  // Una foto con nombre reconocible se nombra, venga de quien venga. La
  // del bot importa tanto como la del cliente: es la que el cliente
  // despues cita con un "este".
  const nombre = nombreDeFoto(m.media_url)
  if (nombre) return `[foto: ${nombre}]`

  // Sin nombre, solo la del cliente aporta (comprobantes, vouchers). La
  // del bot sin nombre si es ruido.
  if (m.sender_type === 'customer') {
    return `[el cliente envió un ${m.content_type}]`
  }
  return null
}

/**
 * Arma el historial de la conversacion para el modelo.
 *
 * Dos agujeros que dejaban ciego al bot y costaron ventas reales:
 *
 *  1. Las fotos del bot se tiraban a la basura por "ruido". Pero son
 *     justo las del catalogo, y son las que el cliente cita.
 *  2. La cita no se miraba. En WhatsApp el cliente contesta *sobre* una
 *     foto y escribe "este". El `reply_to_message_id` ya venia
 *     guardado, pero nadie lo leia, asi que "este" no apuntaba a nada.
 *
 * Osmara respondio TRES veces sobre la foto de Intensa Dulzura ("Este.
 * El precio por favor") y el bot le contesto "No entendi bien" y le
 * pidio elegir de nuevo. Con esto, ese mensaje llega al modelo como
 * "(responde a: [foto: Intensa Dulzura]) Este. El precio por favor".
 *
 * Ordenado del mas viejo al mas nuevo, para que el ultimo mensaje del
 * cliente quede al final.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select(
      'id, sender_type, content_text, content_type, media_url, reply_to_message_id',
    )
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const filas = ((data ?? []) as DbMessage[]).reverse()

  const porId = new Map<string, DbMessage>()
  for (const m of filas) if (m.id) porId.set(m.id, m)

  // Lo citado casi siempre esta en la ventana, pero la foto puede haber
  // quedado afuera por el limite. Esas se traen aparte, de una sola vez.
  const faltantes = [
    ...new Set(
      filas
        .map((m) => m.reply_to_message_id)
        .filter((id): id is string => !!id && !porId.has(id)),
    ),
  ]

  if (faltantes.length > 0) {
    const { data: citados } = await db
      .from('messages')
      .select(
        'id, sender_type, content_text, content_type, media_url, reply_to_message_id',
      )
      .in('id', faltantes)
    for (const m of (citados ?? []) as DbMessage[]) {
      if (m.id) porId.set(m.id, m)
    }
  }

  const salida: ChatMessage[] = []

  for (const m of filas) {
    let cuerpo = describir(m)
    if (!cuerpo) continue

    // Sin esto, un "Este." sobre una foto no dice absolutamente nada.
    const citado = m.reply_to_message_id
      ? porId.get(m.reply_to_message_id)
      : undefined
    if (citado) {
      const resumen = describir(citado)
      if (resumen) {
        const recorte =
          resumen.length > 80 ? `${resumen.slice(0, 80)}…` : resumen
        cuerpo = `(responde a: ${recorte}) ${cuerpo}`
      }
    }

    salida.push({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: cuerpo,
    })
  }

  return salida
}
