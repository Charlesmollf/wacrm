import { describe, it, expect } from 'vitest'
import { MARCA_CARRITO, RE_PEDIDO_CAMBIA, preguntaDeConfirmacion } from './auto-reply'
import { desgloseDelPedido } from './carrito'

/**
 * El caso real que reporto Charles el 1-2 de septiembre: le pidio al bot
 * "Quisiera ver si me pueden agregar un gesha" y el bot contesto sin la
 * marca [[CARRITO: ...]], asi que el sistema penso que el pedido no habia
 * cambiado y le devolvio el pedido viejo. Estas pruebas cubren la deteccion
 * que ahora dispara el reintento (ver auto-reply.ts) para ese mismo caso.
 */
describe('RE_PEDIDO_CAMBIA: detecta pedidos de cambiar el carrito', () => {
  it('reconoce una peticion tentativa, no solo una orden tajante', () => {
    expect(RE_PEDIDO_CAMBIA.test('Quisiera ver si me pueden agregar un gesha.')).toBe(true)
  })

  it('reconoce la orden directa', () => {
    expect(RE_PEDIDO_CAMBIA.test('Agregue un gesha y un pacamara')).toBe(true)
  })

  it('reconoce quitar y cambiar un producto', () => {
    expect(RE_PEDIDO_CAMBIA.test('Podría quitar el pacamara y colocar un maragogipe?')).toBe(true)
  })

  it('reconoce "en vez de" y "mejor un/una"', () => {
    expect(RE_PEDIDO_CAMBIA.test('mejor un maracaturra en vez del pacamara')).toBe(true)
  })

  it('no dispara con una pregunta que no toca el pedido', () => {
    expect(RE_PEDIDO_CAMBIA.test('¿A qué hora abren?')).toBe(false)
    expect(RE_PEDIDO_CAMBIA.test('¿Cuánto cuesta el envío a Petén?')).toBe(false)
  })
})

describe('MARCA_CARRITO: detecta si la respuesta trae la marca invisible', () => {
  it('la detecta en cualquier parte del texto', () => {
    expect(MARCA_CARRITO.test('Perfecto 😊 [[CARRITO: 1 Colosos de America; 1 Gesha]]')).toBe(true)
  })

  it('no la confunde con [[SET: ...]] o [[IMG: ...]]', () => {
    expect(MARCA_CARRITO.test('[[SET: forma_pago=Transferencia]]')).toBe(false)
    expect(MARCA_CARRITO.test('[[IMG: Africa Mia]]')).toBe(false)
  })

  it('el caso real: la respuesta que le llego al cliente no traia la marca', () => {
    const respuestaSinMarca = 'Le confirmo su pedido:\n\nColosos de América — Q345\nEnvío — Q45\n*TOTAL: Q390*'
    expect(MARCA_CARRITO.test(respuestaSinMarca)).toBe(false)
  })
})

/**
 * Cuando el reintento TAMPOCO trae la marca, el bot ya no pasa la
 * conversacion a una persona: le pregunta al cliente el cambio exacto,
 * usando SOLO el desglose ya calculado (nunca el texto del modelo), asi
 * que no puede inventar un producto o un total que no esten en la ficha.
 */
describe('preguntaDeConfirmacion: el bot pregunta en vez de avisarle a Jefe', () => {
  it('muestra el pedido actual y pide el cambio exacto, sin depender del modelo', () => {
    const actual = desgloseDelPedido({ combo_history: '[2026-08-31] 1 Colosos de America' })!
    const pregunta = preguntaDeConfirmacion(actual)
    expect(pregunta).toContain('TOTAL: Q390')
    expect(pregunta).toContain('¿Me puede confirmar exactamente qué cambio quiere hacer')
  })
})
