import { describe, it, expect } from 'vitest'
import { desgloseDelPedido } from './carrito'
import { revisarSalida, mensajeDeRespaldo } from './portero'

/**
 * Prueba de punta a punta del portero: se simula lo que quedo guardado en la
 * ficha del pedido y lo que el modelo escribio, y se comprueba que al cliente
 * le llegue el numero correcto.
 *
 * Son las cuatro conversaciones reales que cobraron mal.
 */
function loQueLeLlegaAlCliente(fila: { combo_history?: string | null }, escribioElBot: string) {
  const desglose = desgloseDelPedido(fila)
  const veredicto = revisarSalida(escribioElBot, desglose)
  if (veredicto.ok) return { texto: escribioElBot, frenado: false }
  return {
    texto: desglose ? mensajeDeRespaldo(desglose) : escribioElBot,
    frenado: true,
    motivo: veredicto.motivo,
  }
}

describe('de punta a punta: las conversaciones que cobraron mal', () => {
  it('Yuri pide tres bolsas y el bot dice Q165', () => {
    const r = loQueLeLlegaAlCliente(
      { combo_history: '[2026-08-31] Tres bolsas de Pacamara' },
      'Tres bolsas de Pacamara molido: Q120 × 3 = Q120 + Q45 de envío = Q165 total',
    )
    expect(r.frenado).toBe(true)
    expect(r.texto).toContain('TOTAL: Q405')
    expect(r.texto).not.toContain('Q165')
  })

  it('Isidro pide Caturra con prensa y el bot dice Q385', () => {
    const r = loQueLeLlegaAlCliente(
      { combo_history: '[2026-08-31] Caturra Roja con prensa francesa' },
      '1 bolsa Caturra Roja Q120 + prensa francesa Q100 + envio Q45 = Q385 total',
    )
    expect(r.frenado).toBe(true)
    expect(r.texto).toContain('TOTAL: Q265')
  })

  it('la Dra. Flor agrega una bolsa y el bot BAJA el total a Q690', () => {
    const r = loQueLeLlegaAlCliente(
      { combo_history: '[2026-08-31] 2 Anaerobico + 1 Pacamara + 2 Peaberry + 1 Maragogipe' },
      'Entonces su pedido seria: el nuevo total seria Q690',
    )
    expect(r.frenado).toBe(true)
    expect(r.texto).toContain('TOTAL: Q765')
  })

  it('Luisa: el bot cobra el envio dos veces y dice Q590', () => {
    const r = loQueLeLlegaAlCliente(
      { combo_history: '[2026-08-31] Africa Mia con prensa francesa' },
      'Su pedido: Q545 + Q45 = Q590 total',
    )
    expect(r.frenado).toBe(true)
    expect(r.texto).toContain('TOTAL: Q545')
  })

  it('cuando el bot acierta, el mensaje pasa tal cual y conserva su tono', () => {
    const bueno = 'Perfecto 😊 Tres bolsas de Pacamara: Q360 + Q45 de envío = Q405 total'
    const r = loQueLeLlegaAlCliente({ combo_history: '[2026-08-31] 3 Pacamara' }, bueno)
    expect(r.frenado).toBe(false)
    expect(r.texto).toBe(bueno)
  })

  it('una consulta de precios sin pedido armado no se toca', () => {
    const consulta = 'El Mítico Cobán cuesta Q345, con prensa Q445 y con cafetera Q545'
    const r = loQueLeLlegaAlCliente({ combo_history: null }, consulta)
    expect(r.frenado).toBe(false)
    expect(r.texto).toBe(consulta)
  })

  it('un pedido que no se puede calcular no bloquea la respuesta', () => {
    const texto = 'Su combo especial queda en Q999 total'
    const r = loQueLeLlegaAlCliente({ combo_history: 'Combo#2' }, texto)
    expect(r.texto).toBe(texto)
  })
})
