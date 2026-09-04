import { describe, expect, it } from 'vitest'
import { calcularGananciaPorMes } from './monthly-profit'

const ACC = 'acc-1'

describe('calcularGananciaPorMes', () => {
  it('agrupa por mes (hora de Guatemala) y suma ventas/costos/ganancia', () => {
    const meses = calcularGananciaPorMes([
      {
        account_id: ACC,
        value: 390,
        sold_at: '2026-08-05T18:00:00Z', // 12pm GT, sigue en agosto
        updated_at: null,
        combo_history: '[2026-08-05] 1 Colosos de America',
        carrito: null,
      },
      {
        account_id: ACC,
        value: 445,
        sold_at: '2026-09-01T02:00:00Z', // 8pm GT del 31-ago -> agosto, no sept
        updated_at: null,
        combo_history: '[2026-08-31] 1 Africa Mia',
        carrito: null,
      },
      {
        account_id: ACC,
        value: 220,
        sold_at: '2026-09-03T15:00:00Z',
        updated_at: null,
        combo_history: '[2026-09-03] 1 Bourbon',
        carrito: null,
      },
    ])

    expect(meses.map((m) => m.month)).toEqual(['2026-08-01', '2026-09-01'])

    const agosto = meses[0]
    expect(agosto.pedidos).toBe(2)
    expect(agosto.ventas).toBe(390 + 445)
    expect(agosto.ganancia).toBeGreaterThan(0)
    expect(agosto.ganancia).toBeLessThan(agosto.ventas)

    const sept = meses[1]
    expect(sept.pedidos).toBe(1)
    expect(sept.ventas).toBe(220)
  })

  it('deal sin carrito reconocible: usa el margen de respaldo en vez de quedar fuera', () => {
    const meses = calcularGananciaPorMes([
      {
        account_id: ACC,
        value: 300,
        sold_at: '2026-08-10T15:00:00Z',
        updated_at: null,
        combo_history: 'texto que el catalogo no reconoce',
        carrito: null,
      },
    ])
    expect(meses).toHaveLength(1)
    expect(meses[0].pedidos).toBe(1)
    expect(meses[0].pedidosSinDesglose).toBe(1)
    expect(meses[0].ventas).toBe(300)
    expect(meses[0].ganancia).toBeGreaterThan(0)
  })

  it('deal sin fecha o sin account_id: se ignora', () => {
    expect(
      calcularGananciaPorMes([
        { account_id: ACC, value: 100, sold_at: null, updated_at: null, combo_history: null, carrito: null },
        { account_id: '', value: 100, sold_at: '2026-08-01T12:00:00Z', updated_at: null, combo_history: null, carrito: null },
      ]),
    ).toEqual([])
  })

  it('separa por cuenta cuando hay mas de una', () => {
    const meses = calcularGananciaPorMes([
      { account_id: 'a', value: 100, sold_at: '2026-08-01T12:00:00Z', updated_at: null, combo_history: null, carrito: null },
      { account_id: 'b', value: 200, sold_at: '2026-08-01T12:00:00Z', updated_at: null, combo_history: null, carrito: null },
    ])
    expect(meses).toHaveLength(2)
    expect(meses.map((m) => m.accountId).sort()).toEqual(['a', 'b'])
  })
})
