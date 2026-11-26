// Lado "pedir un envío": lo usa cualquier proceso, tenga o no el socket.
import { randomBytes } from 'crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { qrHabilitado } from './config'
import { telefonoParaEnviar } from './parse'

export interface PayloadQr {
  type: 'text' | 'image' | 'video' | 'document' | 'audio'
  text?: string | null
  mediaUrl?: string | null
  filename?: string | null
}

/**
 * ¿La cuenta usa QR? Con el interruptor apagado, o si la consulta falla
 * (migración sin correr), responde que no y todo sigue por Cloud API.
 */
export async function cuentaUsaQr(accountId: string): Promise<boolean> {
  if (!qrHabilitado()) return false
  const { data, error } = await supabaseAdmin()
    .from('wa_qr_session')
    .select('status')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[wa-qr] no se pudo consultar la sesión:', error.message)
    return false
  }
  return !!data
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Encola y espera el resultado. `estado: 'sending'` significa que el dueño
 * del socket ya lo tomó pero no confirmó a tiempo.
 */
export async function enviarPorQr(
  accountId: string,
  phone: string,
  payload: PayloadQr,
): Promise<{ waMessageId: string; estado: 'sent' | 'sending' }> {
  const db = supabaseAdmin()
  const waMessageId = `3EB0${randomBytes(9).toString('hex').toUpperCase()}`
  const { error } = await db.from('wa_qr_outbox').insert({
    wa_message_id: waMessageId,
    account_id: accountId,
    phone: telefonoParaEnviar(phone),
    payload,
  })
  if (error) throw new Error(`No se pudo encolar: ${error.message}`)

  const { enviarPendientes, supervisar } = await import('./manager')
  await supervisar()
  void enviarPendientes(accountId)

  const leer = async () => {
    const { data } = await db
      .from('wa_qr_outbox')
      .select('status, error')
      .eq('wa_message_id', waMessageId)
      .maybeSingle()
    return data
  }
  const limite = Date.now() + 25_000
  while (Date.now() < limite) {
    await dormir(500)
    const fila = await leer()
    if (fila?.status === 'sent') return { waMessageId, estado: 'sent' }
    if (fila?.status === 'failed') throw new Error(fila.error || 'No se pudo enviar')
  }
  // Cancelar solo si nadie lo tomó: así nunca sale tarde y sin registro.
  const { data: cancelado } = await db
    .from('wa_qr_outbox')
    .update({ status: 'cancelled' })
    .eq('wa_message_id', waMessageId)
    .eq('status', 'pending')
    .select('wa_message_id')
    .maybeSingle()
  if (cancelado) {
    throw new Error('WhatsApp no está conectado. No se envió; revisa Configuración → WhatsApp.')
  }
  const final = await leer()
  if (final?.status === 'failed') throw new Error(final.error || 'No se pudo enviar')
  return { waMessageId, estado: final?.status === 'sent' ? 'sent' : 'sending' }
}
