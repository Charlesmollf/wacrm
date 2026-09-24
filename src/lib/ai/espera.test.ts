import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { esperarQueTermine, hayMensajeNuevo } from './espera'

type Msg = { conversation_id: string; sender_type: string; message_id: string; received_at: string }

/** Base falsa minima: solo lo que usa espera.ts. */
function dbFalsa(msgs: Msg[]): SupabaseClient {
  return {
    from() {
      const filtros: ((m: Msg) => boolean)[] = []
      let orden: 'asc' | 'desc' = 'desc'
      let lim = 1000
      const run = () => {
        const r = msgs
          .filter((m) => filtros.every((f) => f(m)))
          .sort((a, b) =>
            orden === 'asc'
              ? a.received_at.localeCompare(b.received_at)
              : b.received_at.localeCompare(a.received_at),
          )
          .slice(0, lim)
        return r
      }
      const q = {
        select: () => q,
        eq: (c: keyof Msg, v: string) => (filtros.push((m) => m[c] === v), q),
        neq: (c: keyof Msg, v: string) => (filtros.push((m) => m[c] !== v), q),
        gt: (c: keyof Msg, v: string) => (filtros.push((m) => m[c] > v), q),
        order: (_c: string, o: { ascending: boolean }) => ((orden = o.ascending ? 'asc' : 'desc'), q),
        limit: (n: number) => ((lim = n), q),
        maybeSingle: async () => ({ data: run()[0] ?? null }),
        then: (res: (v: { data: Msg[] }) => unknown) => res({ data: run() }),
      }
      return q
    },
  } as unknown as SupabaseClient
}

const iso = (msAtras: number) => new Date(Date.now() - msAtras).toISOString()

describe('espera del bot', () => {
  it('contesta cuando hay silencio', async () => {
    const msgs: Msg[] = [
      { conversation_id: 'c', sender_type: 'customer', message_id: 'a', received_at: iso(0) },
    ]
    const ancla = await esperarQueTermine(dbFalsa(msgs), 'c', 'a', { silencioMs: 300 })
    expect(ancla).toBe(msgs[0].received_at)
  })

  it('se retira si llega un mensaje mas nuevo durante la espera', async () => {
    const msgs: Msg[] = [
      { conversation_id: 'c', sender_type: 'customer', message_id: 'a', received_at: iso(0) },
    ]
    setTimeout(() => {
      msgs.push({ conversation_id: 'c', sender_type: 'customer', message_id: 'b', received_at: new Date(Date.now() + 5).toISOString() })
    }, 200)
    const ancla = await esperarQueTermine(dbFalsa(msgs), 'c', 'a', { silencioMs: 2500 })
    expect(ancla).toBeNull()
  })

  it('usa la hora de llegada, no la de WhatsApp', async () => {
    const db = dbFalsa([
      { conversation_id: 'c', sender_type: 'customer', message_id: 'a', received_at: iso(9000) },
      { conversation_id: 'c', sender_type: 'customer', message_id: 'b', received_at: iso(1000) },
    ])
    expect(await hayMensajeNuevo(db, 'c', iso(9000))).toBe(true)
    expect(await hayMensajeNuevo(db, 'c', iso(500))).toBe(false)
  })

  it('tope: si el cliente lleva mucho escribiendo sin respuesta, contesta ya', async () => {
    const msgs: Msg[] = [
      { conversation_id: 'c', sender_type: 'bot', message_id: 'x', received_at: iso(60_000) },
      { conversation_id: 'c', sender_type: 'customer', message_id: 'a', received_at: iso(40_000) },
      { conversation_id: 'c', sender_type: 'customer', message_id: 'b', received_at: iso(0) },
    ]
    const t0 = Date.now()
    const ancla = await esperarQueTermine(dbFalsa(msgs), 'c', 'b', { silencioMs: 8000, topeMs: 30_000 })
    expect(ancla).toBe(msgs[2].received_at)
    expect(Date.now() - t0).toBeLessThan(2500)
  })
})
