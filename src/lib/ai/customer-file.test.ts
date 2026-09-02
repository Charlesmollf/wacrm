import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCustomerFile } from './customer-file'

/**
 * El pedido de Jefe (2-9): un cliente de anios (con historial de Kommo)
 * llegaba a la conversacion como si fuera la primera vez, porque la ficha
 * solo miraba la ULTIMA linea de `combo_history`. Estas pruebas cubren que
 * ahora se le pasan al modelo las compras anteriores, y que un dato que ya
 * esta guardado (la direccion, por ejemplo) no se vuelve a pedir.
 */
function fakeDb(rows: {
  contact?: Record<string, unknown> | null
  notes?: Record<string, unknown>[]
  deal?: Record<string, unknown> | null
}): SupabaseClient {
  const chain = (table: string) => ({
    select: () => chain(table),
    eq: () => chain(table),
    order: () => chain(table),
    limit: (n: number) =>
      table === 'contact_notes'
        ? Promise.resolve({ data: (rows.notes ?? []).slice(0, n), error: null })
        : chain(table),
    maybeSingle: () =>
      Promise.resolve({
        data: table === 'contacts' ? (rows.contact ?? null) : (rows.deal ?? null),
        error: null,
      }),
  })
  return { from: (table: string) => chain(table) } as unknown as SupabaseClient
}

describe('buildCustomerFile: cliente con anios de compras', () => {
  it('le pasa al modelo las compras anteriores, no solo la ultima', async () => {
    const { context, missing } = await buildCustomerFile(
      fakeDb({
        contact: { name: 'Yuri Cardona', phone: '50212345678', email: 'yuri@x.com' },
        notes: [{ note_text: 'Cliente de Kommo desde 2023' }],
        deal: {
          address: '3a calle 8-45 zona 3',
          grind: 'Grano',
          combo_history:
            '[2024-03-01] 1 Pacamara\n[2024-11-20] 1 Africa Mia\n[2026-08-31] 1 Colosos de America',
        },
      }),
      'acct-1',
      'contact-1',
    )
    expect(context).toContain(
      'compras anteriores de este cliente: [2024-03-01] 1 Pacamara; [2024-11-20] 1 Africa Mia',
    )
    // La ultima linea sigue siendo el "producto" actual, no se repite ahi.
    expect(context).toContain('- producto: [2026-08-31] 1 Colosos de America')
    // La direccion ya esta guardada: no forma parte de lo que falta.
    expect(missing).not.toContain('direccion')
  })

  it('sin compras previas no menciona historial de compras', async () => {
    const { context } = await buildCustomerFile(
      fakeDb({
        contact: { name: 'Cliente Nuevo' },
        notes: [],
        deal: { combo_history: '[2026-09-01] 1 Gesha' },
      }),
      'acct-1',
      'contact-2',
    )
    // La regla 9 siempre menciona "compras anteriores"; lo que no debe
    // aparecer es la LINEA de la ficha con la lista.
    expect(context).not.toContain('- compras anteriores de este cliente:')
  })
})
