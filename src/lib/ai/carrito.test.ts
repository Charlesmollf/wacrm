import { describe, it, expect } from 'vitest'
import { cuantasUnidades, carritoDesdeTexto, leerCarrito, desgloseDelPedido } from './carrito'

describe('cuantas unidades', () => {
  it('lee el numero adelante, que es lo unico que entendia antes', () => {
    expect(cuantasUnidades('3 Pacamara')).toBe(3)
    expect(cuantasUnidades('3 bolsas de Pacamara')).toBe(3)
  })

  it('lee el numero en LETRAS: el caso Yuri', () => {
    expect(cuantasUnidades('Tres bolsas de Pacamara')).toBe(3)
    expect(cuantasUnidades('dos Anaerobico')).toBe(2)
    expect(cuantasUnidades('cuatro bolsas')).toBe(4)
  })

  it('lee el numero DETRAS del producto', () => {
    expect(cuantasUnidades('Pacamara x 3')).toBe(3)
    expect(cuantasUnidades('Pacamara × 3')).toBe(3)
  })

  it('sin numero es una sola', () => {
    expect(cuantasUnidades('Pacamara')).toBe(1)
    expect(cuantasUnidades('una bolsa de Gesha')).toBe(1)
  })
})

describe('carrito desde texto', () => {
  it('el caso Yuri: tres bolsas dan Q405, no Q165', () => {
    const c = carritoDesdeTexto('Tres bolsas de Pacamara')!
    expect(c.items).toEqual([{ tipo: 'bolsa', nombre: 'pacamara', cantidad: 3 }])
    expect(desgloseDelPedido({ combo_history: 'Tres bolsas de Pacamara' })!.total).toBe(405)
  })

  it('el caso Isidro: un producto nombrado DOS veces no se cobra doble', () => {
    const t = 'Caturra Roja molida con prensa francesa. Eso seria: 1 bolsa Caturra Roja'
    const d = desgloseDelPedido({ combo_history: t })!
    expect(d.cafe).toBe(220)
    expect(d.total).toBe(265)
  })

  it('el caso Dra. Flor: cinco bolsas', () => {
    const t = '2 Anaerobico + 1 Pacamara + 2 Peaberry'
    expect(desgloseDelPedido({ combo_history: t })!.total).toBe(645)
  })

  it('el caso Luisa: combo con prensa no suma el accesorio aparte', () => {
    const d = desgloseDelPedido({ combo_history: 'Africa Mia con prensa francesa' })!
    expect(d.cafe).toBe(500)
    expect(d.total).toBe(545)
  })

  it('respeta el formato con fecha adelante', () => {
    expect(desgloseDelPedido({ combo_history: '[2026-08-31] 04Pacamara' })!.total).toBe(525)
  })

  it('usa la ultima linea del historial, no todas', () => {
    const h = '01IntensaDulzura\n[2026-08-31] 2 Gesha'
    expect(desgloseDelPedido({ combo_history: h })!.cafe).toBe(400)
  })

  it('devuelve null cuando no reconoce nada, en vez de inventar', () => {
    expect(carritoDesdeTexto('hola buenas tardes')).toBe(null)
    expect(carritoDesdeTexto('')).toBe(null)
    expect(desgloseDelPedido({ combo_history: null })).toBe(null)
  })
})

describe('leer carrito guardado', () => {
  it('el carrito guardado manda sobre el historial', () => {
    const fila = {
      carrito: { items: [{ tipo: 'bolsa', nombre: 'Gesha', cantidad: 2 }], accesorioSuelto: 'ninguno' },
      combo_history: '[2026-08-31] 1 Pacamara',
    }
    expect(desgloseDelPedido(fila)!.cafe).toBe(400)
  })

  it('ignora un carrito con forma invalida', () => {
    expect(leerCarrito({ carrito: 'texto suelto' })).toBe(null)
    expect(leerCarrito({ carrito: { items: 'no es lista' } })).toBe(null)
    expect(leerCarrito(null)).toBe(null)
  })

  it('descarta lineas mal formadas pero conserva las buenas', () => {
    const c = leerCarrito({
      carrito: {
        items: [
          { tipo: 'bolsa', nombre: 'Gesha', cantidad: 2 },
          { tipo: 'bolsa', cantidad: 'muchas' },
        ],
        accesorioSuelto: 'prensa',
      },
    })!
    expect(c.items).toHaveLength(1)
    expect(c.accesorioSuelto).toBe('prensa')
  })
})

describe('la cartera real importada de Kommo', () => {
  it('entiende los nombres pegados sin espacios', () => {
    expect(desgloseDelPedido({ combo_history: '01ColososAmerica' })!.cafe).toBe(345)
    expect(desgloseDelPedido({ combo_history: 'AfricaMia' })!.cafe).toBe(400)
    expect(desgloseDelPedido({ combo_history: 'MiticoCoban' })!.cafe).toBe(345)
  })

  it('lee la cantidad del prefijo: 02 son dos combos', () => {
    expect(desgloseDelPedido({ combo_history: '02ProcesosSecretos' })!.cafe).toBe(480)
    expect(desgloseDelPedido({ combo_history: '02MiticoCoban' })!.cafe).toBe(690)
  })

  it('aguanta acentos y espacios de mas', () => {
    expect(desgloseDelPedido({ combo_history: '01MiticoCobán' })!.cafe).toBe(345)
    expect(desgloseDelPedido({ combo_history: '01 Colosos America' })!.cafe).toBe(345)
    expect(desgloseDelPedido({ combo_history: '01ColososAmérica' })!.cafe).toBe(345)
  })

  it('Kennia con doble n es Kenia SL28, que cuesta Q200', () => {
    expect(desgloseDelPedido({ combo_history: '01Kennia' })!.cafe).toBe(200)
  })

  it('varias bolsas separadas por coma', () => {
    expect(desgloseDelPedido({ combo_history: '01Anaerobico, 01Peaberry' })!.cafe).toBe(240)
  })

  it('un combo que no esta en la tabla no se inventa', () => {
    expect(desgloseDelPedido({ combo_history: 'Combo#2' })).toBe(null)
  })
})
