import { describe, expect, it } from 'vitest'
import { telefonoLocal } from './push-order'

describe('telefonoLocal', () => {
  it('le quita el 502 a un numero guardado con codigo de pais', () => {
    expect(telefonoLocal('50230987769')).toBe('30987769')
  })

  it('deja igual un numero que no trae 502 + 8 digitos', () => {
    expect(telefonoLocal('30987769')).toBe('30987769')
  })

  it('null/undefined da string vacio', () => {
    expect(telefonoLocal(null)).toBe('')
    expect(telefonoLocal(undefined)).toBe('')
  })
})
