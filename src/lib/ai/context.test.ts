import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext, nombreDeFoto } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().order().limit() → { data, error }.
 *  `in()` resolves too: it's the second query, the one that fetches a
 *  quoted message that fell outside the window. */
function fakeDb(rows: unknown[], citados: unknown[] = []): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    in: () => Promise.resolve({ data: citados, error: null }),
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: ' ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  // El bot mandaba las fotos del catalogo y despues las tiraba del
  // contexto por "ruido". Eran justo las que el cliente cita.
  it('nombra la foto del catalogo que mando el bot', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          id: 'a',
          sender_type: 'bot',
          content_text: null,
          content_type: 'image',
          media_url:
            'https://cdn.shopify.com/s/files/x/Intensa_Dulzura.jpg?v=1738639250',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'assistant', content: '[foto: Intensa Dulzura]' },
    ])
  })

  // El caso de Osmara: respondio sobre la foto de Intensa Dulzura con
  // "Este. El precio por favor" y el bot contesto "No entendi bien".
  it('resuelve a que foto responde el cliente cuando dice "este"', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          id: 'b',
          sender_type: 'customer',
          content_text: 'Este. El precio por favor',
          content_type: 'text',
          reply_to_message_id: 'a',
        },
        {
          id: 'a',
          sender_type: 'bot',
          content_text: null,
          content_type: 'image',
          media_url:
            'https://cdn.shopify.com/s/files/x/Intensa_Dulzura.jpg?v=1738639250',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'assistant', content: '[foto: Intensa Dulzura]' },
      {
        role: 'user',
        content:
          '(responde a: [foto: Intensa Dulzura]) Este. El precio por favor',
      },
    ])
  })

  it('busca aparte la foto citada que quedo fuera de la ventana', async () => {
    const out = await buildConversationContext(
      fakeDb(
        [
          {
            id: 'b',
            sender_type: 'customer',
            content_text: 'Cuanto el precio de este',
            content_type: 'text',
            reply_to_message_id: 'z',
          },
        ],
        [
          {
            id: 'z',
            sender_type: 'bot',
            content_text: null,
            content_type: 'image',
            media_url:
              'https://cdn.shopify.com/s/files/x/AfricaMia.jpg?v=1738639251',
          },
        ],
      ),
      'conv-1',
    )
    expect(out).toEqual([
      {
        role: 'user',
        content: '(responde a: [foto: Africa Mia]) Cuanto el precio de este',
      },
    ])
  })

  it('conserva el placeholder del comprobante que manda el cliente', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          id: 'a',
          sender_type: 'customer',
          content_text: null,
          content_type: 'image',
          media_url: 'https://mmg.whatsapp.net/v/t62/139082_29_n.enc?ccb=11',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: '[el cliente envió un image]' },
    ])
  })

  it('sigue descartando media del bot sin nombre', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          id: 'a',
          sender_type: 'bot',
          content_text: null,
          content_type: 'sticker',
          media_url: null,
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([])
  })
})

describe('nombreDeFoto', () => {
  it('saca el nombre del producto del CDN de Shopify', () => {
    const base = 'https://cdn.shopify.com/s/files/1/0763/4790/0201/files/'
    expect(nombreDeFoto(`${base}Intensa_Dulzura.jpg?v=1`)).toBe(
      'Intensa Dulzura',
    )
    expect(nombreDeFoto(`${base}ProcesosSecretos.jpg?v=1`)).toBe(
      'Procesos Secretos',
    )
    expect(nombreDeFoto(`${base}AfricaMia.jpg?v=1`)).toBe('Africa Mia')
    expect(nombreDeFoto(`${base}MiticoCoban.jpg`)).toBe('Mitico Coban')
    expect(nombreDeFoto(`${base}Colosos_de_America.jpg`)).toBe(
      'Colosos de America',
    )
  })

  // Mejor "[foto]" a secas que inventarle un nombre a la foto.
  it('no le inventa nombre a los hashes del CDN de WhatsApp', () => {
    expect(
      nombreDeFoto('https://mmg.whatsapp.net/v/t62/13908_29_n.enc?ccb=11-4'),
    ).toBeNull()
    expect(
      nombreDeFoto('https://mmg.whatsapp.net/v/t62/486203847362819.jpg'),
    ).toBeNull()
    expect(nombreDeFoto(null)).toBeNull()
    expect(nombreDeFoto(undefined)).toBeNull()
  })
})
