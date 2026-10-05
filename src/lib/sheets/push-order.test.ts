import { describe, it, expect } from 'vitest'
import { conPaquetes, sinRepetidos } from './push-order'

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
    expect(conPaquetes('Intensa Dulzura + Colosos de América')).toBe('Intensa Dulzura + Colosos de América')
    expect(conPaquetes('Mítico Cobán')).toBe('Mítico Cobán')
    expect(conPaquetes('Africa Mia con cafetera italiana')).toBe('Africa Mia con cafetera italiana')
  })
  it('bolsas sueltas no cambian y no duplica', () => {
    expect(conPaquetes('2 Bourbon + Catuai + Caturra Roja')).toBe('2 Bourbon + Catuai + Caturra Roja')
    expect(conPaquetes('Highland Coban (4 paquetes)')).toBe('Highland Coban (4 paquetes)')
  })
})

describe('sinRepetidos', () => {
  it('la aclaracion reemplaza a la linea corta', () => {
    expect(sinRepetidos(['África Mía', 'África Mía con prensa francesa'])).toEqual(['África Mía con prensa francesa'])
    expect(sinRepetidos(['Cardamomo', '2 Cardamomo'])).toEqual(['2 Cardamomo'])
  })
  it('productos distintos se quedan', () => {
    expect(sinRepetidos(['Maracaturra', 'Catuai'])).toEqual(['Maracaturra', 'Catuai'])
  })
})
