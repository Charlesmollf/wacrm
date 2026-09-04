import { describe, expect, it } from 'vitest'
import { combinarComboHistory } from './deal-updates'

/**
 * Caso real de Geronimo Ramirez C. (2-3 sept 2026): confirmo su pedido de
 * Colosos de America + Intensa Dulzura + Mitico Coban a las 18:23 del 2 de
 * sept, y al dia siguiente (21:46 del 3 de sept) solo aclaro que las tres
 * bolsas van en grano — mismo pedido, mismo producto, sin pagar todavia.
 * `combo_history` quedo con DOS lineas del mismo pedido porque el codigo
 * viejo solo reemplazaba la linea de HOY.
 */
describe('combinarComboHistory', () => {
  it('historial vacio: la linea nueva, sola', () => {
    expect(combinarComboHistory(null, '[2026-09-02] 1 Gesha', false)).toBe('[2026-09-02] 1 Gesha')
  })

  it('la misma linea ya guardada: no la duplica', () => {
    const prev = '[2026-09-02] 1 Gesha'
    expect(combinarComboHistory(prev, '[2026-09-02] 1 Gesha', false)).toBe(prev)
  })

  it('recompra genuina (esPedidoNuevo): agrega la linea nueva, conserva todo', () => {
    const prev = '[2026-08-31] 1 Colosos de America'
    expect(combinarComboHistory(prev, '[2026-09-02] 1 Africa Mia', true)).toBe(
      '[2026-08-31] 1 Colosos de America\n[2026-09-02] 1 Africa Mia',
    )
  })

  it('mismo pedido, mismo dia: reemplaza la unica linea', () => {
    const prev = '[2026-09-02] 1 Colosos de America'
    expect(
      combinarComboHistory(prev, '[2026-09-02] 1 Colosos de America (grano)', false),
    ).toBe('[2026-09-02] 1 Colosos de America (grano)')
  })

  it('el caso real: mismo pedido pero la aclaracion llego al dia SIGUIENTE', () => {
    const prev = '[2026-09-02] Colosos de America + Intensa Dulzura + Mitico Coban'
    const resultado = combinarComboHistory(
      prev,
      '[2026-09-03] Colosos de America + Intensa Dulzura + Mitico Coban',
      false,
    )
    expect(resultado).toBe('[2026-09-03] Colosos de America + Intensa Dulzura + Mitico Coban')
    expect(resultado.split('\n')).toHaveLength(1)
  })

  it('mismo pedido cruzando el dia, con compras anteriores YA cerradas: solo reemplaza la ultima', () => {
    const prev =
      '[2026-08-20] 1 Gesha\n[2026-09-02] Colosos de America + Intensa Dulzura + Mitico Coban'
    const resultado = combinarComboHistory(
      prev,
      '[2026-09-03] Colosos de America + Intensa Dulzura + Mitico Coban',
      false,
    )
    expect(resultado).toBe(
      '[2026-08-20] 1 Gesha\n[2026-09-03] Colosos de America + Intensa Dulzura + Mitico Coban',
    )
  })
})
