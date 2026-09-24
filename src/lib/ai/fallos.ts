import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyHumanNeeded } from '@/lib/notify/human-alert'
import { mensajeDe } from './generate'

/**
 * Guarda en `ai_failures` cada vez que el bot fallo con un cliente y, si el
 * cliente se quedo SIN respuesta, avisa a Jefe por correo. Antes esto solo
 * iba a los logs de Hostinger y nadie se enteraba (23-09, 21:48 "las 2").
 * Nunca lanza.
 */
export async function registrarFallo(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    etapa: 'modelo' | 'respaldo' | 'dispatch'
    modelo?: string | null
    error: unknown
    /** true = contesto el modelo de respaldo; el cliente SI recibio respuesta. */
    respondioRespaldo?: boolean
  },
): Promise<void> {
  const texto = mensajeDe(args.error).slice(0, 1000)
  try {
    await db.from('ai_failures').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      etapa: args.etapa,
      modelo: args.modelo ?? null,
      error: texto,
      respondio_respaldo: !!args.respondioRespaldo,
    })
  } catch (err) {
    console.error('[ai fallos] no se pudo guardar el fallo:', err)
  }
  if (args.respondioRespaldo) return
  await notifyHumanNeeded(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    asunto: '⚠️ El bot no pudo contestarle a {cliente}',
    motivo:
      'El bot falló y el cliente se quedó sin respuesta. Contéstale a mano. ' +
      `Motivo: ${texto.slice(0, 200).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}`,
  })
}
