import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: { type?: string; text?: string }[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// El prompt de sistema (persona + catalogo oficial + politicas) es el
// mismo en TODAS las llamadas y pesa varios miles de tokens. Marcarlo
// como cacheable hace que Anthropic lo cobre completo solo la primera
// vez y despues al 10% mientras el cache siga vivo. Con TTL de 1 hora
// un solo "write" cubre toda una rafaga de conversaciones, que es
// exactamente como llegan los mensajes de WhatsApp.
//
// El cache tiene un minimo (~1024 tokens); por debajo de eso Anthropic
// ignora la marca, asi que ni la ponemos y evitamos el sobrecosto de
// escritura (2x) sin beneficio.
const CACHE_MIN_CHARS = 4000

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

type SystemParam =
  | string
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl: '1h' } }[]

/** Marca el prompt de sistema como cacheable cuando vale la pena. */
function cacheableSystem(systemPrompt: string): SystemParam {
  if (!systemPrompt || systemPrompt.length < CACHE_MIN_CHARS) return systemPrompt
  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': 'extended-cache-ttl-2025-04-11',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: cacheableSystem(systemPrompt),
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: normalizeForAnthropic(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  // `input_tokens` NO incluye lo servido desde cache: hay que sumarlo
  // para que el contador de uso del CRM siga reflejando el tamano real
  // del prompt (si no, pareceria que el bot de golpe "piensa" menos).
  const usage = normalizeUsage({
    prompt:
      (data?.usage?.input_tokens ?? 0) +
      (data?.usage?.cache_creation_input_tokens ?? 0) +
      (data?.usage?.cache_read_input_tokens ?? 0),
    completion: data?.usage?.output_tokens,
  })
  return { text, usage }
}
