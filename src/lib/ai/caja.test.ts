import { describe, it, expect } from 'vitest'
import { calcularPedido, textoDelDesglose, ErrorDeCatalogo } from './caja'

describe('caja registradora', () => {
  it('una bolsa suelta', () => {
    const d = calcularPedido([{ tipo: 'bolsa', nombre: 'Pacamara', cantidad: 1 }])
    expect(d.cafe).toBe(120)
    expect(d.total).toBe(165)
  })

  it('multiplica bien: el caso Yuri, 3 bolsas de Pacamara', () => {
    // El bot dijo "Q120 x 3 = Q120 + Q45 = Q165". Eran Q405.
    const d = calcularPedido([{ tipo: 'bolsa', nombre: 'Pacamara', cantidad: 3 }])
    expect(d.cafe).toBe(360)
    expect(d.total).toBe(405)
  })

  it('agregar una cuarta bolsa recalcula desde cero', () => {
    const d = calcularPedido([{ tipo: 'bolsa', nombre: 'Pacamara', cantidad: 4 }])
    expect(d.total).toBe(525)
  })

  it('el caso Isidro: bolsa suelta con prensa francesa', () => {
    // El bot dijo Q385. Eran 120 + 100 + 45 = 265.
    const d = calcularPedido(
      [{ tipo: 'bolsa', nombre: 'Caturra Roja', cantidad: 1 }],
      'prensa',
    )
    expect(d.cafe).toBe(220)
    expect(d.total).toBe(265)
  })

  it('el caso Dra. Flor: cinco bolsas', () => {
    // El bot cobro Q765 (6 bolsas) donde eran 5.
    const d = calcularPedido([
      { tipo: 'bolsa', nombre: 'Anaerobico', cantidad: 2 },
      { tipo: 'bolsa', nombre: 'Pacamara', cantidad: 1 },
      { tipo: 'bolsa', nombre: 'Peaberry', cantidad: 2 },
    ])
    expect(d.cafe).toBe(600)
    expect(d.total).toBe(645)
  })

  it('el caso Dra. Flor: al agregar una bolsa el total SUBE', () => {
    // El bot dijo que el nuevo total era Q690, menos que antes.
    const antes = calcularPedido([
      { tipo: 'bolsa', nombre: 'Anaerobico', cantidad: 2 },
      { tipo: 'bolsa', nombre: 'Pacamara', cantidad: 1 },
      { tipo: 'bolsa', nombre: 'Peaberry', cantidad: 2 },
    ])
    const despues = calcularPedido([
      { tipo: 'bolsa', nombre: 'Anaerobico', cantidad: 2 },
      { tipo: 'bolsa', nombre: 'Pacamara', cantidad: 1 },
      { tipo: 'bolsa', nombre: 'Peaberry', cantidad: 2 },
      { tipo: 'bolsa', nombre: 'Maragogipe', cantidad: 1 },
    ])
    expect(despues.total).toBe(765)
    expect(despues.total).toBeGreaterThan(antes.total)
  })

  it('quitar una bolsa recalcula, no ajusta', () => {
    const d = calcularPedido([
      { tipo: 'bolsa', nombre: 'Anaerobico', cantidad: 2 },
      { tipo: 'bolsa', nombre: 'Peaberry', cantidad: 2 },
    ])
    expect(d.total).toBe(525)
  })

  it('el caso Luisa: combo con prensa NO es combo + prensa', () => {
    // Africa Mia sola Q400; con prensa Q500, no Q400+Q100.
    // Y el envio se cobra UNA vez: Q500 + Q45 = Q545, nunca Q590.
    const d = calcularPedido([
      { tipo: 'combo', nombre: 'África Mía', cantidad: 1, accesorio: 'prensa' },
    ])
    expect(d.cafe).toBe(500)
    expect(d.total).toBe(545)
  })

  it('combo con cafetera', () => {
    const d = calcularPedido([
      { tipo: 'combo', nombre: 'África Mía', cantidad: 1, accesorio: 'cafetera' },
    ])
    expect(d.total).toBe(590)
  })

  it('las premium cuestan Q200 y no se confunden con las de Q120', () => {
    expect(calcularPedido([{ tipo: 'bolsa', nombre: 'Kenia SL28', cantidad: 1 }]).cafe).toBe(200)
    expect(calcularPedido([{ tipo: 'bolsa', nombre: 'Gesha', cantidad: 1 }]).cafe).toBe(200)
    expect(calcularPedido([{ tipo: 'bolsa', nombre: 'Caturra Roja', cantidad: 1 }]).cafe).toBe(120)
  })

  it('el envio es uno solo aunque el pedido lleve muchas cosas', () => {
    const d = calcularPedido([
      { tipo: 'bolsa', nombre: 'Bourbon', cantidad: 3 },
      { tipo: 'bolsa', nombre: 'Catuai', cantidad: 2 },
    ])
    expect(d.envio).toBe(45)
    expect(d.total).toBe(645)
  })

  it('cantidades grandes', () => {
    const d = calcularPedido([{ tipo: 'bolsa', nombre: 'Pacamara', cantidad: 20 }])
    expect(d.total).toBe(2445)
  })

  it('un pedido vacio no cobra envio', () => {
    const d = calcularPedido([])
    expect(d.total).toBe(0)
    expect(d.envio).toBe(0)
  })

  it('un producto que no existe falla limpio, no inventa', () => {
    expect(() =>
      calcularPedido([{ tipo: 'bolsa', nombre: 'Cafe de Marte', cantidad: 1 }]),
    ).toThrow(ErrorDeCatalogo)
    expect(() =>
      calcularPedido([{ tipo: 'combo', nombre: 'Combo Inexistente', cantidad: 1 }]),
    ).toThrow(ErrorDeCatalogo)
  })

  it('una cantidad absurda falla limpio', () => {
    expect(() =>
      calcularPedido([{ tipo: 'bolsa', nombre: 'Pacamara', cantidad: 0 }]),
    ).toThrow(ErrorDeCatalogo)
    expect(() =>
      calcularPedido([{ tipo: 'bolsa', nombre: 'Pacamara', cantidad: 1.5 }]),
    ).toThrow(ErrorDeCatalogo)
  })

  it('el texto del desglose muestra el mismo total que la caja', () => {
    const d = calcularPedido([{ tipo: 'bolsa', nombre: 'Pacamara', cantidad: 3 }])
    expect(textoDelDesglose(d)).toContain('TOTAL: Q405')
  })
})
