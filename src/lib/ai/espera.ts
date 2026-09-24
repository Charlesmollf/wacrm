import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * ESPERAR A QUE EL CLIENTE TERMINE DE ESCRIBIR.
 *
 * Meta no avisa cuando el cliente esta "escribiendo…", asi que se adivina
 * por silencio: el bot contesta cuando pasan `silencioMs` sin mensajes nuevos
 * del cliente. Cada mensaje nuevo tiene su propio handler; el viejo se retira
 * en cuanto ve uno mas nuevo, y el mas nuevo vuelve a esperar. Resultado: la
 * espera se reinicia con cada mensaje.
 *
 * Se compara por `received_at` (hora de LLEGADA al servidor), no por
 * `created_at` (hora de WhatsApp, en segundos y a veces atrasada). Mezclar
 * las dos hacia que el debounce viejo no viera el mensaje nuevo (23-09,
 * "como está" 21:33:05 + "me encantan los cafés ácidos" 21:33:14).
 *
 * Tope: si el cliente lleva `topeMs` escribiendo sin respuesta, se contesta
 * ya, sin esperar mas silencio.
 */

export const SILENCIO_MS = 8_000
export const TOPE_MS = 30_000
const POLL_MS = 1_000

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Hora de llegada del mensaje que disparo este handler. */
async function anclaDelMensaje(
  db: SupabaseClient,
  conversationId: string,
  waMessageId?: string,
): Promise<string | null> {
  let q = db
    .from('messages')
    .select('received_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
  if (waMessageId) q = q.eq('message_id', waMessageId)
  const { data } = await q
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.received_at as string | undefined) ?? null
}

/** ¿Llego algun mensaje del cliente DESPUES de `ancla`? */
export async function hayMensajeNuevo(
  db: SupabaseClient,
  conversationId: string,
  ancla: string,
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .gt('received_at', ancla)
    .limit(1)
  return !!data && data.length > 0
}

/** Hora de llegada del primer mensaje del cliente que sigue sin respuesta. */
async function primerSinResponder(
  db: SupabaseClient,
  conversationId: string,
): Promise<number | null> {
  const { data: ultimaNuestra } = await db
    .from('messages')
    .select('received_at')
    .eq('conversation_id', conversationId)
    .neq('sender_type', 'customer')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  let q = db
    .from('messages')
    .select('received_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
  if (ultimaNuestra?.received_at) q = q.gt('received_at', ultimaNuestra.received_at)
  const { data } = await q.order('received_at', { ascending: true }).limit(1).maybeSingle()
  return data?.received_at ? new Date(data.received_at as string).getTime() : null
}

/**
 * Espera a que el cliente deje de escribir.
 * Devuelve el ancla (hora de llegada del mensaje de este handler) para
 * volver a revisar antes de mandar, o `null` si llego un mensaje mas nuevo
 * y este handler debe retirarse (el del mensaje nuevo contesta con todo).
 */
export async function esperarQueTermine(
  db: SupabaseClient,
  conversationId: string,
  waMessageId?: string,
  opts: { silencioMs?: number; topeMs?: number } = {},
): Promise<string | null> {
  const silencioMs = opts.silencioMs ?? SILENCIO_MS
  const topeMs = opts.topeMs ?? TOPE_MS

  const ancla = await anclaDelMensaje(db, conversationId, waMessageId)
  if (!ancla) return new Date().toISOString() // sin datos: no bloquear la respuesta

  const inicio = Date.now()
  const primero = await primerSinResponder(db, conversationId).catch(() => null)
  const limiteTope = primero != null ? primero + topeMs : Infinity
  const fin = Math.min(inicio + silencioMs, Math.max(limiteTope, inicio + POLL_MS))

  while (Date.now() < fin) {
    await dormir(Math.min(POLL_MS, Math.max(0, fin - Date.now())))
    if (await hayMensajeNuevo(db, conversationId, ancla)) return null
  }
  return ancla
}
