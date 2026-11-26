// Traducción pura de un mensaje de WhatsApp Web a las columnas de `messages`.

export interface MensajeQr {
  contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location'
  text: string | null
  /** Mime del adjunto, si hay que descargarlo. */
  mediaMime: string | null
}

type Nodo = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Quita las envolturas (efímero, ver una vez, documento con texto). */
export function desenvolver(msg: Nodo | null | undefined): Nodo | null {
  let m = msg ?? null
  for (let i = 0; m && i < 5; i++) {
    const dentro =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.documentWithCaptionMessage?.message
    if (!dentro) break
    m = dentro
  }
  return m
}

/** null = no es un mensaje que deba verse en el chat (reacción, protocolo…). */
export function leerMensaje(raw: Nodo | null | undefined): MensajeQr | null {
  const m = desenvolver(raw)
  if (!m) return null
  const base = { text: null, mediaMime: null }
  const texto = m.conversation || m.extendedTextMessage?.text
  if (texto) return { ...base, contentType: 'text', text: texto }
  if (m.imageMessage) {
    return { contentType: 'image', text: m.imageMessage.caption || null, mediaMime: m.imageMessage.mimetype || 'image/jpeg' }
  }
  if (m.stickerMessage) {
    return { contentType: 'image', text: null, mediaMime: m.stickerMessage.mimetype || 'image/webp' }
  }
  if (m.videoMessage) {
    return { contentType: 'video', text: m.videoMessage.caption || null, mediaMime: m.videoMessage.mimetype || 'video/mp4' }
  }
  if (m.audioMessage) {
    return { ...base, contentType: 'audio', mediaMime: m.audioMessage.mimetype || 'audio/ogg' }
  }
  if (m.documentMessage) {
    const d = m.documentMessage
    return { contentType: 'document', text: d.caption || d.fileName || null, mediaMime: d.mimetype || 'application/octet-stream' }
  }
  if (m.locationMessage) {
    const l = m.locationMessage
    return {
      ...base,
      contentType: 'location',
      text: [l.name, l.address, `${l.degreesLatitude},${l.degreesLongitude}`].filter(Boolean).join(' - '),
    }
  }
  if (m.contactMessage) {
    return { ...base, contentType: 'text', text: `[Contacto] ${m.contactMessage.displayName ?? ''}`.trim() }
  }
  return null
}

/** Solo chats 1 a 1: fuera grupos, estados, canales y listas de difusión. */
export function esChatPersonal(jid: string | null | undefined): jid is string {
  return !!jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))
}

export function telefonoDeJid(jid: string): string {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '')
}

/** Contactos guardados sin código de país (8 dígitos) son de Guatemala. */
export function telefonoParaEnviar(phone: string): string {
  const d = phone.replace(/\D/g, '')
  return d.length === 8 ? `502${d}` : d
}
