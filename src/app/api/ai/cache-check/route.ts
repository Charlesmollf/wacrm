import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { retrieveAllKnowledge } from '@/lib/ai/knowledge'
import { splitSystem } from '@/lib/ai/providers/anthropic'

export const maxDuration = 60

/**
 * GET /api/ai/cache-check  (admin)
 *
 * Prueba de que el cache de prompts REALMENTE esta acertando.
 *
 * Hace 3 llamadas seguidas con el MISMO prefijo estable y devuelve, por
 * llamada, los tokens de escritura y de lectura de cache. Lo correcto:
 *
 *   llamada 1 → creation alto, read = 0     (se escribe el cache)
 *   llamada 2 → read alto,     fresh bajo   (se lee del cache)
 *   llamada 3 → read alto,     fresh bajo
 *
 * Si `read` sigue en 0 en la llamada 2, el prefijo esta cambiando entre
 * llamadas y el cache no sirve de nada — que es exactamente el fallo
 * silencioso que esta ruta existe para detectar. No manda nada a ningun
 * cliente: habla solo con Anthropic.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const admin = supabaseAdmin()

    const config = await loadAiConfig(admin, accountId)
    if (!config) {
      return NextResponse.json({ error: 'IA no configurada' }, { status: 400 })
    }
    if (config.provider !== 'anthropic') {
      return NextResponse.json(
        { error: `El cache solo aplica a Anthropic (proveedor actual: ${config.provider})` },
        { status: 400 },
      )
    }

    const knowledge = await retrieveAllKnowledge(admin, accountId)
    const stableSystem = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })
    // Igual que en produccion: lo volatil va DESPUES del prefijo.
    const volatil = '\n\nFICHA DE PRUEBA: cliente ficticio, no existe.'
    const systemPrompt = stableSystem + volatil

    const pruebas = ['hola', 'que precio tiene', 'gracias']
    const resultados: Record<string, unknown>[] = []

    for (const texto of pruebas) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'extended-cache-ttl-2025-04-11',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          system: splitSystem(systemPrompt, stableSystem),
          max_tokens: 16,
          messages: [{ role: 'user', content: texto }],
        }),
      })
      const data = (await res.json().catch(() => null)) as {
        usage?: {
          input_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          output_tokens?: number
        }
        error?: { message?: string }
      } | null

      if (!res.ok) {
        resultados.push({ mensaje: texto, error: data?.error?.message ?? res.statusText })
        continue
      }
      const u = data?.usage
      resultados.push({
        mensaje: texto,
        cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
        input_tokens: u?.input_tokens ?? 0,
        output_tokens: u?.output_tokens ?? 0,
      })
    }

    const segunda = resultados[1] as { cache_read_input_tokens?: number } | undefined
    const acierta = (segunda?.cache_read_input_tokens ?? 0) > 0

    return NextResponse.json({
      prefijo_estable_chars: stableSystem.length,
      fragmentos_de_conocimiento: knowledge.length,
      resultados,
      veredicto: acierta
        ? 'OK: el cache esta acertando (la 2a llamada leyo del cache).'
        : 'FALLA: la 2a llamada no leyo del cache — el prefijo esta cambiando entre llamadas.',
    })
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? ((err as { status?: number }).status ?? 500)
        : 500
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error inesperado' },
      { status },
    )
  }
}
