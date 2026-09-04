import { describe, expect, it } from 'vitest'
import { carritoDesdeTexto } from '../ai/carrito'
import { margenDelCarrito, margenDelDeal } from './margenes'

describe('margenDelCarrito', () => {
  it('combo reconocido: ganancia positiva y menor que la venta', () => {
    const carrito = carritoDesdeTexto('1 Colosos de America')!
    const m = margenDelCarrito(carrito)!
    expect(m.ventaCatalogo).toBe(390) // 345 + 45 de envio
    expect(m.costoCatalogo).toBeGreaterThan(0)
    expect(m.costoCatalogo).toBeLessThan(m.ventaCatalogo)
  })

  it('bolsas sueltas: el costo es el mismo por bolsa sin importar la variedad', () => {
    const carrito = carritoDesdeTexto('2 Pacamara')!
    const m = margenDelCarrito(carrito)!
    // 2 bolsas x Q26.86 + envio (Q26) = Q79.72
    expect(m.costoCatalogo).toBeCloseTo(2 * 26.86 + 26, 2)
  })

  it('carrito vacio o no reconocido: null', () => {
    expect(margenDelCarrito(null)).toBeNull()
    expect(margenDelCarrito(carritoDesdeTexto('hola buenas tardes'))).toBeNull()
  })
})

describe('margenDelDeal', () => {
  it('lee del combo_history cuando no hay carrito guardado', () => {
    const m = margenDelDeal({ combo_history: '[2026-08-01] 1 Africa Mia' })!
    expect(m.ventaCatalogo).toBe(445) // 400 + 45
    expect(m.costoCatalogo).toBeGreaterThan(0)
  })

  it('deal sin combo_history reconocible: null (el llamador usa el margen de respaldo)', () => {
    expect(margenDelDeal({ combo_history: 'algo que el catalogo no reconoce' })).toBeNull()
    expect(margenDelDeal({ combo_history: null })).toBeNull()
  })
})
