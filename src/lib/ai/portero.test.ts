import { describe, it, expect } from 'vitest'
import { revisarSalida } from './portero'

/**
 * El 1-2 de septiembre el portero comparaba el mensaje contra un carrito
 * guardado aparte. Ese carrito no traia la cafetera suelta que Charles
 * habia pedido, asi que un mensaje CORRECTO (Q605) se freno y se le mando
 * al cliente el total viejo (Q405), dos veces seguidas.
 *
 * Ahora el portero no mira ningun carrito: revisa el desglose que EL
 * PROPIO MENSAJE escribio, linea por linea, contra el catalogo.
 */
describe('revisarSalida: verifica el desglose que el mensaje escribe, sin carrito', () => {
  it('cafetera suelta junto a bolsas: el caso real del 1-9, Q605 pasa tal cual', () => {
    const t =
      'Pacamara — Q120\n2x Bourbon — Q240\nCafetera italiana — Q200\nEnvío — Q45\n*TOTAL: Q605*'
    expect(revisarSalida(t).ok).toBe(true)
  })

  it('esa misma cuenta con el TOTAL viejo (Q405) se corrige a Q605, sin tocar el resto', () => {
    const t =
      'Pacamara — Q120\n2x Bourbon — Q240\nCafetera italiana — Q200\nEnvío — Q45\n*TOTAL: Q405*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.corregido).toContain('*TOTAL: Q605*')
    // Todo lo demas del mensaje queda igual: no se reescribe la cuenta entera.
    expect(v.corregido).toContain('Cafetera italiana — Q200')
    expect(v.corregido).toContain('2x Bourbon — Q240')
  })

  it('suma mala: cada linea esta bien pero el TOTAL no es la suma, se corrige solo el total', () => {
    const t = 'Colosos de América — Q345\nEnvío — Q45\n*TOTAL: Q400*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.motivo).toContain('Q400')
    expect(v.corregido).toBe('Colosos de América — Q345\nEnvío — Q45\n*TOTAL: Q390*')
  })

  it('precio unitario malo: se corrige esa linea (el total ya coincidia con lo escrito)', () => {
    const t = 'Colosos de América — Q300\nEnvío — Q45\n*TOTAL: Q345*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.motivo).toContain('Q300')
    expect(v.corregido).toContain('Colosos de América — Q345')
  })

  it('combo con prensa francesa: Q490 no es el precio, se corrige a Q445', () => {
    const t = 'Intensa Dulzura con prensa francesa — Q490\nEnvío — Q45\n*TOTAL: Q535*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.corregido).toContain('Intensa Dulzura con prensa francesa — Q445')
  })

  it('una explicacion de precios sin tabla no se bloquea', () => {
    const t = 'Con prensa serían Q445, y con cafetera Q545.'
    expect(revisarSalida(t)).toEqual({ ok: true })
  })

  it('una cuenta bancaria que no es la oficial bloquea, sin intentar corregirla sola', () => {
    const t = 'Puede transferir a la cuenta 20-1234567-8 y me manda el comprobante.'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.corregido).toBeUndefined()
  })

  it('no confunde un numero de guia con una cuenta', () => {
    const t = 'Su número de guía es A417469997-1. Cuenta Monetaria: 30-3093873-2'
    expect(revisarSalida(t).ok).toBe(true)
  })

  it('un producto fuera de catalogo no se juzga en su propia linea, pero si cuenta para el total', () => {
    const t = 'Combo especial navideño — Q999\nEnvío — Q45\n*TOTAL: Q1044*'
    // La linea del combo especial no se toca (no esta en el catalogo), y el
    // total (999 + 45) si cuadra con lo que el mensaje ya afirma.
    expect(revisarSalida(t)).toEqual({ ok: true })
  })

  it('el mismo producto fuera de catalogo, pero con un TOTAL que no suma, si se corrige', () => {
    const t = 'Combo especial navideño — Q999\nEnvío — Q45\n*TOTAL: Q999*'
    const v = revisarSalida(t)
    expect(v.ok).toBe(false)
    expect(v.corregido).toContain('*TOTAL: Q1044*')
  })
})
