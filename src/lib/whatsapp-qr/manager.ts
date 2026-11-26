// Dueño del socket de WhatsApp Web dentro del proceso de Next.js.
//
// - `supervisar()` se llama al arrancar el servidor, cada pocos segundos y
//   desde pg_cron. Es idempotente.
// - Un candado en la base (wa_qr_acquire_lease) garantiza un solo socket
//   aunque Hostinger levante dos procesos.
// - Lo saliente pasa por wa_qr_outbox: solo el dueño del socket lo envía.
import { randomUUID } from 'crypto'
import type { AnyMessageContent, WASocket } from 'baileys'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { qrHabilitado } from './config'
import { borrarCredenciales, usarAuthEnBase } from './auth-state'
import { guardarMensajeQr } from './inbound'
import type { PayloadQr } from './outbox'

const TTL_CANDADO = 45
const CADA_SUPERVISION = 15_000
const CADA_ENVIOS = 2_000
/** Un pendiente más viejo que esto ya no se envía (quien lo pidió ya desistió). */
const VIDA_PENDIENTE = 60_000

interface Sesion {
  sock: WASocket | null
  conectado: boolean
  iniciando: boolean
  enviando: boolean
  reintentos: number
  noAntesDe: number
  /** Escrituras de credenciales en curso: reconectar espera a que terminen. */
  guardando: Promise<void>
}

interface Estado {
  owner: string
  sesiones: Map<string, Sesion>
  relojes: boolean
}

// En globalThis: Next empaqueta instrumentation y las rutas por separado.
const g = globalThis as unknown as { __waQr?: Estado }
const estado: Estado = (g.__waQr ??= { owner: randomUUID(), sesiones: new Map(), relojes: false })

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function sesionDe(accountId: string): Sesion {
  let s = estado.sesiones.get(accountId)
  if (!s) {
    s = { sock: null, conectado: false, iniciando: false, enviando: false, reintentos: 0, noAntesDe: 0, guardando: Promise.resolve() }
    estado.sesiones.set(accountId, s)
  }
  return s
}

async function guardarEstado(accountId: string, cambios: Record<string, unknown>) {
  const { error } = await supabaseAdmin()
    .from('wa_qr_session')
    .update({ ...cambios, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('lease_owner', estado.owner)
  if (error) console.error('[wa-qr] no se guardó el estado:', error.message)
}

function cerrar(accountId: string) {
  const s = sesionDe(accountId)
  const sock = s.sock
  s.sock = null
  s.conectado = false
  // end() cierra la conexión sin desvincular el dispositivo.
  sock?.end(undefined)
}

async function conectar(accountId: string, userId: string) {
  const s = sesionDe(accountId)
  if (s.sock || s.iniciando || Date.now() < s.noAntesDe) return
  s.iniciando = true
  try {
    const baileys = await import('baileys')
    const { default: pino } = await import('pino')
    const logger = pino({ level: 'silent' })
    await s.guardando
    const { state, saveCreds } = await usarAuthEnBase(accountId)
    const sock = baileys.makeWASocket({
      auth: { creds: state.creds, keys: baileys.makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: baileys.Browsers.ubuntu('CRM'),
      // El teléfono sigue recibiendo sus notificaciones.
      markOnlineOnConnect: false,
      // Sin historial: solo lo que llegue desde que se conecta.
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
    })
    s.sock = sock

    // Cola en serie: dos mensajes seguidos no deben crear dos contactos.
    let cola: Promise<void> = Promise.resolve()

    sock.ev.on('creds.update', () => {
      s.guardando = s.guardando
        .then(saveCreds)
        .catch((e) => console.error('[wa-qr] creds:', msg(e)))
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        // 'append' trae lo propio y lo pendiente tras una caída; lo viejo se ignora.
        const edad = Date.now() / 1000 - Number(m.messageTimestamp ?? 0)
        if (type !== 'notify' && edad > 24 * 3600) continue
        cola = cola
          .then(() => guardarMensajeQr(sock, accountId, userId, m))
          .catch((e) => console.error('[wa-qr] entrante:', msg(e)))
      }
    })

    sock.ev.on('connection.update', (u) => {
      if (s.sock !== sock) return
      if (u.qr) {
        void guardarEstado(accountId, { status: 'qr', qr: u.qr, last_error: null })
      }
      if (u.connection === 'open') {
        s.conectado = true
        s.reintentos = 0
        const phone = sock.user?.id.split(/[:@]/)[0] ?? null
        void guardarEstado(accountId, { status: 'connected', qr: null, phone, last_error: null })
      }
      if (u.connection === 'close') {
        s.sock = null
        s.conectado = false
        const error = u.lastDisconnect?.error as
          | (Error & { output?: { statusCode?: number } })
          | undefined
        const codigo = error?.output?.statusCode
        const { DisconnectReason } = baileys

        if (codigo === DisconnectReason.loggedOut) {
          // Se desvinculó desde el teléfono: la sesión ya no sirve.
          void borrarCredenciales(accountId)
            .catch((e) => console.error('[wa-qr]', msg(e)))
            .then(() =>
              guardarEstado(accountId, { enabled: false, status: 'logged_out', qr: null, phone: null }),
            )
          return
        }
        if (!state.creds.me && codigo !== DisconnectReason.restartRequired) {
          // Nadie escaneó el QR: parar hasta que lo vuelvan a pedir.
          void s.guardando
            .then(() => borrarCredenciales(accountId))
            .catch((e) => console.error('[wa-qr]', msg(e)))
            .then(() => guardarEstado(accountId, { enabled: false, status: 'qr_expired', qr: null }))
          return
        }
        s.reintentos += 1
        const espera =
          codigo === DisconnectReason.restartRequired
            ? 0
            : codigo === DisconnectReason.connectionReplaced
              ? 60_000
              : Math.min(60_000, 2_000 * 2 ** Math.min(s.reintentos, 5))
        s.noAntesDe = Date.now() + espera
        void guardarEstado(accountId, {
          status: 'reconnecting',
          qr: null,
          last_error: `${codigo ?? ''} ${error?.message ?? ''}`.trim() || null,
        })
        setTimeout(() => void supervisar(), espera + 500)
      }
    })
  } catch (e) {
    console.error('[wa-qr] no se pudo conectar:', msg(e))
    s.noAntesDe = Date.now() + 30_000
    await guardarEstado(accountId, { status: 'error', last_error: msg(e) })
  } finally {
    s.iniciando = false
  }
}

export async function enviarPendientes(accountId: string): Promise<void> {
  const s = sesionDe(accountId)
  if (!s.sock || !s.conectado || s.enviando) return
  s.enviando = true
  const db = supabaseAdmin()
  try {
    const { data: filas, error } = await db
      .from('wa_qr_outbox')
      .select('wa_message_id, phone, payload, created_at')
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5)
    if (error) throw new Error(error.message)
    for (const fila of filas ?? []) {
      const sock = s.sock
      if (!sock || !s.conectado) break
      const vencido = Date.now() - new Date(fila.created_at).getTime() > VIDA_PENDIENTE
      const { data: tomada } = await db
        .from('wa_qr_outbox')
        .update({ status: vencido ? 'failed' : 'sending', error: vencido ? 'vencido' : null })
        .eq('wa_message_id', fila.wa_message_id)
        .eq('status', 'pending')
        .select('wa_message_id')
        .maybeSingle()
      if (!tomada || vencido) continue
      try {
        const [destino] = (await sock.onWhatsApp(fila.phone)) ?? []
        if (!destino?.exists) throw new Error('Ese número no tiene WhatsApp')
        await sock.sendMessage(destino.jid, contenido(fila.payload as PayloadQr), {
          messageId: fila.wa_message_id,
        })
        await db.from('wa_qr_outbox').update({ status: 'sent' }).eq('wa_message_id', fila.wa_message_id)
        await db.from('messages').update({ status: 'sent' }).eq('message_id', fila.wa_message_id)
      } catch (e) {
        await db
          .from('wa_qr_outbox')
          .update({ status: 'failed', error: msg(e) })
          .eq('wa_message_id', fila.wa_message_id)
        await db.from('messages').update({ status: 'failed' }).eq('message_id', fila.wa_message_id)
      }
    }
  } catch (e) {
    console.error('[wa-qr] envíos:', msg(e))
  } finally {
    s.enviando = false
  }
}

function contenido(p: PayloadQr): AnyMessageContent {
  if (p.type === 'text') return { text: p.text ?? '' }
  const url = { url: p.mediaUrl! }
  if (p.type === 'image') return { image: url, caption: p.text || undefined }
  if (p.type === 'video') return { video: url, caption: p.text || undefined }
  if (p.type === 'audio') return { audio: url, mimetype: 'audio/ogg; codecs=opus', ptt: true }
  return {
    document: url,
    fileName: p.filename || 'documento',
    mimetype: mimePorNombre(p.filename || p.mediaUrl!),
    caption: p.text && p.text !== p.filename ? p.text : undefined,
  }
}

function mimePorNombre(nombre: string): string {
  const ext = nombre.split('?')[0].split('.').pop()?.toLowerCase() ?? ''
  const tipos: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
  }
  return tipos[ext] ?? 'application/octet-stream'
}

let supervisando = false

export async function supervisar(): Promise<void> {
  if (!qrHabilitado() || supervisando) return
  supervisando = true
  try {
    iniciarRelojes()
    const db = supabaseAdmin()
    const { data: filas, error } = await db.from('wa_qr_session').select('account_id, user_id, enabled')
    if (error) throw new Error(error.message)
    const activas = new Set<string>()
    for (const f of filas ?? []) {
      if (!f.enabled) continue
      const { data: mio, error: lockError } = await db.rpc('wa_qr_acquire_lease', {
        p_account: f.account_id,
        p_owner: estado.owner,
        p_ttl_seconds: TTL_CANDADO,
      })
      if (lockError) throw new Error(lockError.message)
      if (!mio) continue
      activas.add(f.account_id)
      await conectar(f.account_id, f.user_id)
    }
    // Sin candado (o apagada) no se puede seguir con el socket abierto.
    for (const id of estado.sesiones.keys()) {
      if (!activas.has(id)) cerrar(id)
    }
  } catch (e) {
    console.error('[wa-qr] supervisión:', msg(e))
  } finally {
    supervisando = false
  }
}

function iniciarRelojes() {
  if (estado.relojes) return
  estado.relojes = true
  setInterval(() => void supervisar(), CADA_SUPERVISION).unref()
  setInterval(() => {
    for (const id of estado.sesiones.keys()) void enviarPendientes(id)
  }, CADA_ENVIOS).unref()
}

/** Desvincula el dispositivo, borra credenciales y apaga la sesión. */
export async function desvincular(accountId: string): Promise<void> {
  const s = sesionDe(accountId)
  const sock = s.sock
  s.sock = null
  s.conectado = false
  if (sock) await sock.logout().catch((e) => console.error('[wa-qr] logout:', msg(e)))
  // Apagar primero: el proceso que tenga el candado cierra al supervisar.
  const { error } = await supabaseAdmin()
    .from('wa_qr_session')
    .update({
      enabled: false,
      status: 'disconnected',
      qr: null,
      phone: null,
      lease_owner: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
  if (error) throw new Error(error.message)
  await borrarCredenciales(accountId)
}
