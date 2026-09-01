import { describe, it, expect } from 'vitest'
import { calcularPedido } from './caja'
import { revisarSalida, totalAfirmado, mensajeDeRespaldo, parteConversacional } from './portero'

const yuri = calcularPedido([{ tipo: 'bolsa', nombre: 'Pacamara', cantidad: 3 }])
const isidro = calcularPedido(
  [{ tipo: 'bolsa', nombre: 'Caturra Roja', cantidad: 1 }],
  'prensa',
)

describe('portero', () => {
  it('deja pasar un mensaje con el total correcto', () => {
    const t = 'Tres bolsas de Pacamara molido: Q360 + Q45 de envío = Q405 total'
    expect(revisarSalida(t, yuri).ok).toBe(true)
  })

  it('FRENA el error de Yuri', () => {
    const t = 'Tres bolsas de Pacamara molido: Q120 × 3 = Q120 + Q45 de envío = Q165 total'
    const v = revisarSalida(t, yuri)
    expect(v.ok).toBe(false)
    expect(v.motivo).toContain('Q165')
  })

  it('FRENA el error de Isidro', () => {
    const t = '1 bolsa Caturra Roja Q120 + prensa francesa Q100 + envio Q45 = Q385 total'
    expect(revisarSalida(t, isidro).ok).toBe(false)
  })

  it('deja pasar el mensaje correcto de Isidro', () => {
    const t = '1 bolsa Caturra Roja Q120 + prensa francesa Q100 + envio Q45 = Q265 total'
    expect(revisarSalida(t, isidro).ok).toBe(true)
  })

  it('FRENA una cifra inventada aunque el total este bien', () => {
    const t = 'Su pedido son Q405 total, y le regalo un descuento de Q50'
    const v = revisarSalida(t, yuri)
    expect(v.ok).toBe(false)
    expect(v.cifrasRaras).toContain(50)
  })

  it('FRENA una cuenta bancaria que no es la nuestra', () => {
    const t = 'Para la transferencia, cuenta monetaria: 33-0462917-1'
    expect(revisarSalida(t, null).ok).toBe(false)
  })

  it('deja pasar la cuenta oficial', () => {
    const t = 'Para la transferencia, Cuenta Monetaria: 30-3093873-2'
    expect(revisarSalida(t, null).ok).toBe(true)
  })

  it('no bloquea una consulta de precios sin pedido armado', () => {
    const t = 'El Mítico Cobán cuesta Q345, y con prensa francesa Q445'
    expect(revisarSalida(t, null).ok).toBe(true)
  })

  it('permite subtotales legitimos de un pedido con varias lineas', () => {
    const flor = calcularPedido([
      { tipo: 'bolsa', nombre: 'Anaerobico', cantidad: 2 },
      { tipo: 'bolsa', nombre: 'Pacamara', cantidad: 1 },
      { tipo: 'bolsa', nombre: 'Peaberry', cantidad: 2 },
    ])
    const t = 'Son Q240 de Anaerobico, Q120 de Pacamara y Q240 de Peaberry: Q600 + Q45 = Q645 total'
    expect(revisarSalida(t, flor).ok).toBe(true)
  })

  it('FRENA el error de la Dra. Flor: agrega una bolsa y baja el total', () => {
    const conMara = calcularPedido([
      { tipo: 'bolsa', nombre: 'Anaerobico', cantidad: 2 },
      { tipo: 'bolsa', nombre: 'Pacamara', cantidad: 1 },
      { tipo: 'bolsa', nombre: 'Peaberry', cantidad: 2 },
      { tipo: 'bolsa', nombre: 'Maragogipe', cantidad: 1 },
    ])
    const t = 'el nuevo total seria Q690'
    expect(revisarSalida(t, conMara).ok).toBe(false)
  })

  it('lee el total en sus formas comunes', () => {
    expect(totalAfirmado('TOTAL: Q405')).toBe(405)
    expect(totalAfirmado('*Total: Q645*')).toBe(645)
    expect(totalAfirmado('= Q265 total')).toBe(265)
    expect(totalAfirmado('Monto a transferir: Q765')).toBe(null)
    expect(totalAfirmado('Total a transferir: Q765')).toBe(765)
  })

  it('el mensaje de respaldo trae el total de la caja', () => {
    expect(mensajeDeRespaldo(yuri)).toContain('TOTAL: Q405')
  })

  it('no confunde un numero de guia con una cuenta', () => {
    const t = 'Su número de guía es A417469997-1. Cuenta Monetaria: 30-3093873-2'
    expect(revisarSalida(t, null).ok).toBe(true)
  })
})

describe('el mensaje de respaldo conserva el tono', () => {
  it('mantiene el saludo del modelo y cambia solo la cuenta', () => {
    const escribio = 'Perfecto \u{1F60A} Se lo preparo en molido.\nSon Q120 \u00D7 3 = Q165 total'
    const m = mensajeDeRespaldo(yuri, escribio)
    expect(m).toContain('Perfecto \u{1F60A} Se lo preparo en molido.')
    expect(m).toContain('TOTAL: Q405')
    expect(m).not.toContain('Q165')
  })

  it('si el modelo arranco directo con numeros, usa el texto propio', () => {
    const m = mensajeDeRespaldo(yuri, 'Q120 \u00D7 3 = Q165 total')
    expect(m).toContain('Le confirmo su pedido')
    expect(m).toContain('TOTAL: Q405')
  })

  it('sin texto original tambien funciona', () => {
    expect(mensajeDeRespaldo(yuri)).toContain('TOTAL: Q405')
  })

  it('parteConversacional corta donde empiezan los numeros', () => {
    expect(parteConversacional('Hola, con gusto le ayudo.\nSon Q345 mas envio')).toBe(
      'Hola, con gusto le ayudo.',
    )
    expect(parteConversacional('Q345 mas envio')).toBe('')
  })
})
