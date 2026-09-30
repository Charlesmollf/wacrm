import { describe, it, expect } from 'vitest'
import { construirContextoPedido } from './pedido-contexto'

const base = { value: 765, payment_method: 'Link de pago', combo_history: '[2026-08-15] 2 Catuai', notes: null, created_at: '2026-08-15T14:00:00Z' }
const ahora = new Date('2026-09-30T20:00:00Z').getTime()

describe('construirContextoPedido', () => {
  it('pagado hace mas de 7 dias → cerrado, pedido nuevo', () => {
    const t = construirContextoPedido({ ...base, payment_status: 'Pagado' }, ahora)
    expect(t).toContain('ESTA CERRADO')
    expect(t).toContain('PEDIDO NUEVO')
  })
  it('pagado reciente → pregunta', () => {
    const t = construirContextoPedido({ ...base, payment_status: 'Pagado', created_at: '2026-09-28T10:00:00Z' }, ahora)
    expect(t).toContain('reciente')
    expect(t).toContain('Pregunta claro')
  })
  it('por confirmar → pedido vivo', () => {
    const t = construirContextoPedido({ ...base, payment_status: 'Por confirmar', created_at: '2026-09-29T10:00:00Z' }, ahora)
    expect(t).toContain('REGLA CRITICA')
  })
})
