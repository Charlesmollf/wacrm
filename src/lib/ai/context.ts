import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: string | null
}

/**
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`.
 *
 * Non-text messages (media, documents, stickers) are included as short
 * placeholders — e.g. "[el cliente envió un image]" — so the model can
 * see that a receipt/photo/document arrived days ago and relate a
 * follow-up question to it, instead of that event being invisible.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text, content_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .map((m) => {
      const text = m.content_text?.trim()
      if (text) return { m, content: text }
      // Placeholder for media so the transcript keeps the event. Only
      // customer media matters for grounding (receipts, vouchers); bot
      // media (product photos) is noise — skip it.
      if (
        m.sender_type === 'customer' &&
        m.content_type &&
        m.content_type !== 'text'
      ) {
        return { m, content: `[el cliente envió un ${m.content_type}]` }
      }
      return null
    })
    .filter((x): x is { m: DbMessage; content: string } => x !== null)
    .map(({ m, content }) => ({
      role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const),
      content,
    }))
}
