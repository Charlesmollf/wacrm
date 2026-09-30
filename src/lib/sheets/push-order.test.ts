import { describe, it, expect } from 'vitest'
import { conPaquetes } from './push-order'

describe('conPaquetes', () => {
  it('Highland Coban = 4 paquetes', () => {
    expect(conPaquetes('Combo #4 Highland Coban')).toBe('Combo #4 Highland Coban (4 paquetes)')
    expect(conPaquetes('Highland Cobán')).toBe('Highland Cobán (4 paquetes)')
  })
  it('Combo #2 y #3', () => {
    expect(conPaquetes('Combo #2')).toBe('Combo #2 (2 paquetes)')
    expect(conPaquetes('Combo3')).toBe('Combo3 (3 paquetes)')
  })
  it('combos con nombre y suma', () => {
    expect(conPaquetes('Intensa Dulzura + Colosos de América')).toBe(
      'Intensa Dulzura (3 paquetes) + Colosos de América (3 paquetes)',
    )
    expect(conPaquetes('Africa Mia con cafetera italiana')).toBe('Africa Mia con cafetera italiana (2 paquetes)')
  })
  it('bolsas sueltas no cambian y no duplica', () => {
    expect(conPaquetes('2 Bourbon + Catuai + Caturra Roja')).toBe('2 Bourbon + Catuai + Caturra Roja')
    expect(conPaquetes('Highland Coban (4 paquetes)')).toBe('Highland Coban (4 paquetes)')
  })
})
