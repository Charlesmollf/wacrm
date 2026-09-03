import { describe, expect, it } from 'vitest'
import { normalizarTelefono } from './parse-guia-pdf'

describe('normalizarTelefono', () => {
  it('antepone 502 a un numero local de 8 digitos', () => {
    expect(normalizarTelefono('3023-0524')).toBe('50230230524')
  })

  it('deja igual un numero de 11 digitos que ya trae 502', () => {
    expect(normalizarTelefono('502 3098 7769')).toBe('50230987769')
  })

  it('rechaza el corte real del 2-9-2026: 8 digitos que ya empiezan con 502', () => {
    // Guia de Katherine Valenzuela Tojin: el campo trajo "50230987"
    // (el "502" del codigo de pais + los primeros 5 digitos del numero
    // real, 30987769). Anteponer otro 502 daria "50250230987", que no
    // es el telefono de nadie.
    expect(normalizarTelefono('50230987')).toBeNull()
  })

  it('sigue rechazando basura de otras longitudes', () => {
    expect(normalizarTelefono('123')).toBeNull()
    expect(normalizarTelefono('')).toBeNull()
  })
})
