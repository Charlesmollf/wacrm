import { describe, expect, it } from 'vitest'
import { esChatPersonal, leerMensaje, telefonoDeJid, telefonoParaEnviar } from './parse'

describe('leerMensaje', () => {
  it('lee texto, también dentro de un mensaje efímero', () => {
    expect(leerMensaje({ conversation: 'hola' })?.text).toBe('hola')
    expect(
      leerMensaje({ ephemeralMessage: { message: { extendedTextMessage: { text: 'x' } } } })?.text,
    ).toBe('x')
  })
  it('trata el sticker como imagen y conserva el nombre del documento', () => {
    expect(leerMensaje({ stickerMessage: {} })?.contentType).toBe('image')
    expect(leerMensaje({ documentMessage: { fileName: 'poliza.pdf' } })?.text).toBe('poliza.pdf')
  })
  it('ignora reacciones y mensajes de protocolo', () => {
    expect(leerMensaje({ reactionMessage: { text: '👍' } })).toBeNull()
    expect(leerMensaje({ protocolMessage: {} })).toBeNull()
  })
})

describe('teléfonos y chats', () => {
  it('solo acepta chats 1 a 1', () => {
    expect(esChatPersonal('50251818508@s.whatsapp.net')).toBe(true)
    expect(esChatPersonal('123@lid')).toBe(true)
    expect(esChatPersonal('123@g.us')).toBe(false)
    expect(esChatPersonal('status@broadcast')).toBe(false)
    expect(esChatPersonal('123@newsletter')).toBe(false)
  })
  it('normaliza números', () => {
    expect(telefonoDeJid('50251818508:12@s.whatsapp.net')).toBe('50251818508')
    expect(telefonoParaEnviar('5181-8508')).toBe('50251818508')
    expect(telefonoParaEnviar('+502 5181 8508')).toBe('50251818508')
  })
})
