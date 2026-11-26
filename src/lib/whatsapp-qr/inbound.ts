// Guarda en el inbox lo que pasa por el WhatsApp conectado por QR: lo que
// escribe el cliente y lo que se contesta desde el teléfono (`fromMe`).
// A propósito NO dispara bot, flujos, automatizaciones ni difusiones.
import type { WAMessage, WASocket } from 'baileys'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { esChatPersonal, leerMensaje, desenvolver, telefonoDeJid } from './parse'

const MAX_MEDIA_BYTES = 25 * 1024 * 1024

async function telefonoDelMensaje(sock: WASocket, msg: WAMessage): Promise<string | null> {
  const jid = msg.key.remoteJid
  if (!esChatPersonal(jid)) return null
  if (jid.endsWith('@s.whatsapp.net')) return telefonoDeJid(jid)
  // WhatsApp a veces identifica el chat con un id oculto (@lid).
  const alt = msg.key.remoteJidAlt
  if (alt?.endsWith('@s.whatsapp.net')) return telefonoDeJid(alt)
  const pn = await sock.signalRepository.lidMapping.getPNForLID(jid)
  return pn ? telefonoDeJid(pn) : null
}

async function contactoPara(accountId: string, userId: string, phone: string, nombre: string | null) {
  const db = supabaseAdmin()
  const existente = await findExistingContact(db, accountId, phone)
  if (existente) return existente.id
  const { data, error } = await db
    .from('contacts')
    .insert({ account_id: accountId, user_id: userId, phone, name: nombre || phone, wa_profile_name: nombre })
    .select('id')
    .single()
  if (!error) return data.id as string
  if (isUniqueViolation(error)) return (await findExistingContact(db, accountId, phone))?.id ?? null
  throw new Error(`contacto: ${error.message}`)
}

async function conversacionPara(accountId: string, userId: string, contactId: string) {
  const db = supabaseAdmin()
  const buscar = async () => {
    const { data, error } = await db
      .from('conversations')
      .select('id, status, unread_count')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)
    if (error) throw new Error(`conversación: ${error.message}`)
    return data?.[0] ?? null
  }
  const existente = await buscar()
  if (existente) return existente
  const { data, error } = await db
    .from('conversations')
    .insert({ account_id: accountId, user_id: userId, contact_id: contactId })
    .select('id, status, unread_count')
    .single()
  if (!error) return data
  if (isUniqueViolation(error)) return buscar()
  throw new Error(`conversación: ${error.message}`)
}

/** Guarda el adjunto en el mismo archivo que lee /api/whatsapp/media/<id>. */
async function archivar(accountId: string, msg: WAMessage, mime: string): Promise<string | null> {
  try {
    const contenido = desenvolver(msg.message as Record<string, unknown>)
    const nodo = contenido && (Object.values(contenido).find((v) => v?.fileLength !== undefined) as { fileLength?: unknown } | undefined)
    if (Number(nodo?.fileLength ?? 0) > MAX_MEDIA_BYTES) return null
    const { downloadMediaMessage } = await import('baileys')
    const buffer = await downloadMediaMessage(msg, 'buffer', {})
    const mediaId = `qr-${msg.key.id!.replace(/[^A-Za-z0-9_-]/g, '')}`
    const { error } = await supabaseAdmin()
      .storage.from('whatsapp-media')
      .upload(`${accountId}/${mediaId}`, buffer, { contentType: mime, upsert: true })
    if (error) throw new Error(error.message)
    return `/api/whatsapp/media/${mediaId}`
  } catch (err) {
    console.error('[wa-qr] no se pudo guardar el adjunto:', err instanceof Error ? err.message : err)
    return null
  }
}

export async function guardarMensajeQr(
  sock: WASocket,
  accountId: string,
  userId: string,
  msg: WAMessage,
): Promise<void> {
  const id = msg.key.id
  if (!id) return
  const parsed = leerMensaje(msg.message as Record<string, unknown>)
  if (!parsed) return
  const phone = await telefonoDelMensaje(sock, msg)
  if (!phone) {
    if (esChatPersonal(msg.key.remoteJid)) console.warn('[wa-qr] mensaje sin teléfono resoluble:', id)
    return
  }
  const db = supabaseAdmin()
  const fromMe = !!msg.key.fromMe

  // Lo enviado desde el CRM ya lo guarda el envío: acá solo es el eco.
  if (fromMe) {
    const { data, error } = await db
      .from('wa_qr_outbox')
      .select('wa_message_id')
      .eq('wa_message_id', id)
      .maybeSingle()
    if (error) throw new Error(`outbox: ${error.message}`)
    if (data) return
  }

  const contactId = await contactoPara(accountId, userId, phone, fromMe ? null : msg.pushName || null)
  if (!contactId) return
  const conv = await conversacionPara(accountId, userId, contactId)
  if (!conv) return

  const { data: repetido } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conv.id)
    .eq('message_id', id)
    .limit(1)
  if (repetido?.length) return

  const mediaUrl = parsed.mediaMime ? await archivar(accountId, msg, parsed.mediaMime) : null
  const cuando = new Date(Number(msg.messageTimestamp ?? Date.now() / 1000) * 1000).toISOString()

  const { error: insertError } = await db.from('messages').insert({
    conversation_id: conv.id,
    sender_type: fromMe ? 'agent' : 'customer',
    content_type: parsed.contentType,
    content_text: parsed.text,
    media_url: mediaUrl,
    message_id: id,
    status: fromMe ? 'sent' : 'delivered',
    created_at: cuando,
  })
  if (insertError) throw new Error(`mensaje: ${insertError.message}`)

  const ahora = new Date().toISOString()
  const update: Record<string, unknown> = {
    last_message_text: parsed.text || `[${parsed.contentType}]`,
    last_message_at: ahora,
    updated_at: ahora,
  }
  if (fromMe) {
    update.last_outbound_at = ahora
  } else {
    update.last_inbound_at = ahora
    update.unread_count = (conv.unread_count || 0) + 1
    if (conv.status === 'closed') update.status = 'open'
  }
  const { error } = await db.from('conversations').update(update).eq('id', conv.id)
  if (error) console.error('[wa-qr] conversación sin actualizar:', error.message)
}
