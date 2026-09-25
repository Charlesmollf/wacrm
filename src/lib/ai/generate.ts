import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /**
   * Prefijo estable de `systemPrompt` (identico en toda llamada) para
   * que Anthropic lo cachee. Ver `ProviderArgs.cachePrefix`.
   */
  cachePrefix?: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Tiempo maximo de esta llamada. Por defecto `aiRequestTimeoutMs()`. */
  timeoutMs?: number
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, cachePrefix, messages } = args
  const timeoutMs = args.timeoutMs ?? aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    cachePrefix,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}

/**
 * SEGUNDO INTENTO. Si el modelo principal falla (caido, "temporarily
 * unavailable", timeout), el cliente NO se queda sin respuesta: se contesta
 * con otro modelo. El 23-09 Sonnet 5 dio timeouts y el cliente quedo en
 * visto sin que nadie se enterara.
 * `AI_FALLBACK_MODEL` lo cambia; `none` lo apaga.
 */
export function modeloDeRespaldo(config: AiConfig): string | null {
  const env = process.env.AI_FALLBACK_MODEL?.trim()
  if (env) return env.toLowerCase() === 'none' ? null : env
  if (config.provider !== 'anthropic') return null
  // Jefe (25-09): todo en Sonnet 5. El respaldo es un segundo intento con
  // el MISMO modelo; si tambien falla, queda en ai_failures y llega correo.
  return config.model
}

export interface ResultadoConRespaldo {
  reply: GenerateResult
  /** Modelo que de verdad contesto. */
  modelo: string
  /** Error del modelo principal, si fallo y contesto el respaldo. */
  errorPrincipal: unknown | null
}

/**
 * Llama al modelo principal y, si falla, al de respaldo, sin pasarse de
 * `deadline` (ms epoch). La ruta del webhook muere a los 60 s sin dejar
 * error: cada llamada recibe solo el tiempo que queda.
 * Si fallan los dos, lanza un AiError con los dos motivos.
 */
export async function generarConRespaldo(
  args: GenerateArgs & { deadline: number },
): Promise<ResultadoConRespaldo> {
  const { deadline, ...base } = args
  const queda = () => deadline - Date.now()
  const respaldo = modeloDeRespaldo(base.config)

  // Si hay respaldo, se le guardan ~15 s; si no, el principal usa todo.
  const reserva = respaldo ? 15_000 : 1_000
  const tPrincipal = Math.min(aiRequestTimeoutMs(), Math.max(5_000, queda() - reserva))
  try {
    const reply = await generateReply({ ...base, timeoutMs: tPrincipal })
    return { reply, modelo: base.config.model, errorPrincipal: null }
  } catch (errPrincipal) {
    const tRespaldo = Math.min(20_000, queda() - 1_000)
    if (!respaldo || tRespaldo < 4_000) throw errPrincipal
    console.error(
      `[ai] ${base.config.model} fallo; contesta el respaldo ${respaldo}:`,
      errPrincipal,
    )
    try {
      const reply = await generateReply({
        ...base,
        config: { ...base.config, model: respaldo },
        timeoutMs: tRespaldo,
      })
      return { reply, modelo: respaldo, errorPrincipal: errPrincipal }
    } catch (errRespaldo) {
      throw new AiError(
        `Fallaron ${base.config.model} (${mensajeDe(errPrincipal)}) y ${respaldo} (${mensajeDe(errRespaldo)})`,
        { code: 'all_models_failed' },
      )
    }
  }
}

export function mensajeDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
