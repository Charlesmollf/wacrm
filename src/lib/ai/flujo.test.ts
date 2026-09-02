import { describe, it, expect } from 'vitest'
import { revisarSalida } from './portero'

/**
 * Las mismas cuatro conversaciones reales que cobraron mal (Yuri, Isidro, la
 * Dra. Flor, Luisa), pero verificadas como las revisa el portero ahora: sin
 * ningun carrito de por medio, solo el desglose que el propio mensaje trae.
 *
 * Antes esta prueba armaba un `Desglose` con `calcularPedido` a partir de
 * `combo_history` y se lo pasaba a `revisarSalida` como segundo argumento.
 * Ese desglose externo es justo lo que fallo el 1-9 (ver portero.test.ts):
 * ya no existe ese segundo argumento.
 */
describe('de punta a punta: las conversaciones que cobraron mal', () => {
  it('Yuri pide tres bolsas y el bot dice Q165', () => {
    const t = '3x Pacamara — Q360\nEnvío — Q45\n*TOTAL: Q165*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.corregido).toContain('TOTAL: Q405')
  })

  it('Isidro pide Caturra con prensa y el bot dice Q385', () => {
    const t = 'Caturra Roja — Q220\nEnvío — Q45\n*TOTAL: Q385*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    // La linea de Caturra Roja tampoco es su precio (Q120): se corrige esa
    // primero, antes de llegar siquiera al total.
    expect(v.corregido).toContain('Caturra Roja — Q120')
  })

  it('la Dra. Flor agrega una bolsa y el bot BAJA el total a Q690', () => {
    const t =
      '2x Anaerobico — Q240\nPacamara — Q120\n2x Peaberry — Q240\nMaragogipe — Q120\nEnvío — Q45\n*TOTAL: Q690*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.corregido).toContain('TOTAL: Q765')
  })

  it('Luisa: el bot cobra el envio dos veces y dice Q590', () => {
    const t = 'África Mía con prensa francesa — Q500\nEnvío — Q45\nEnvío — Q45\n*TOTAL: Q590*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.motivo).toContain('envío')
    // Un envio duplicado no se corrige solo: es ambiguo cual de los dos
    // sobra, asi que no hay `corregido` y el mensaje pasa a una persona.
    expect(v.corregido).toBeUndefined()
  })

  it('cuando el bot acierta, el mensaje pasa tal cual', () => {
    const bueno = '3x Pacamara — Q360\nEnvío — Q45\n*TOTAL: Q405*'
    expect(revisarSalida(bueno)).toEqual({ ok: true })
  })

  it('una consulta de precios sin pedido armado no se toca', () => {
    const consulta = 'El Mítico Cobán cuesta Q345, con prensa Q445 y con cafetera Q545'
    expect(revisarSalida(consulta)).toEqual({ ok: true })
  })

  it('Sara Elena: el bot hace la cuenta en una frase y dice Q390 (el total real es Q510)', () => {
    const t =
      '*Intensa Dulzura* Q345 + *1 Peaberry* Q120 = Q345 + Q45 de envío = *Q390 total*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    // No se suma a ciegas: el propio mensaje trae un resultado parcial
    // ("= Q345") mezclado entre los montos, asi que sumar todo daria OTRO
    // numero mal. Se bloquea sin `corregido` y pasa a una persona.
    expect(v.corregido).toBeUndefined()
  })
})
