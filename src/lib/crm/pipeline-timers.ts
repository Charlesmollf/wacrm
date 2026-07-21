import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Pipeline clockwork for the Kaffeejager flow:
//
//   - Business-hours guard: automated customer messages go out ONLY
//     Mon-Fri 07:00-21:00 Guatemala time. Outside the window the cron
//     defers; the next in-window run delivers.
//   - Enviado → Ganados after 5 business days (Mon-Fri).
//   - First time a contact lands in Ganados with a real sale →
//     "Cliente nuevo" tag (imported cartera already carries
//     "Cliente viejo" and is skipped).
//   - "Cliente nuevo" → "Cliente viejo" 30 days after the tag was
//     applied (the tag row's created_at is the fixed clock).
//
// All best-effort: each block swallows its own errors so one failure
// never blocks the rest of the cron run.
// ============================================================

/** Guatemala is UTC-6 year-round (no DST). */
const GT_OFFSET_MS = -6 * 3_600_000

function toGT(d: Date): Date {
  return new Date(d.getTime() + GT_OFFSET_MS)
}

/** Mon-Fri 07:00–20:59 Guatemala time. */
export function isBusinessHoursGT(now: Date = new Date()): boolean {
  const gt = toGT(now)
  const dow = gt.getUTCDay() // 0=Sun .. 6=Sat
  const hour = gt.getUTCHours()
  return dow >= 1 && dow <= 5 && hour >= 7 && hour < 21
}

/** Whole business days (Mon-Fri, GT calendar) elapsed since `fromIso`. */
export function businessDaysSince(fromIso: string, now: Date = new Date()): number {
  const from = new Date(fromIso)
  if (Number.isNaN(from.getTime()) || from >= now) return 0
  let count = 0
  const cursor = new Date(from)
  for (let i = 0; i < 400; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    if (cursor > now) break
    const dow = toGT(cursor).getUTCDay()
    if (dow >= 1 && dow <= 5) count++
  }
  return count
}

interface StageRow {
  id: string
  pipeline_id: string
  name: string
}

interface TimerResult {
  movedToGanados: number
  movedToPerdidos: number
  taggedNuevo: number
  rotatedViejo: number
}

/** Café-agnostic tags that must NEVER be swept as cold coffee leads —
 *  the insurance/personal book stays isolated per the owner's rule. */
const PROTECTED_TAG_NAMES = [
  'otro-negocio-seguros',
  'seguros',
  'fianzas',
  'personal',
  'persona-clave',
]

/** Calendar days since an ISO timestamp. */
function daysSince(iso: string, now: Date): number {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return (now.getTime() - t) / 86_400_000
}

export async function runPipelineTimers(
  db: SupabaseClient,
): Promise<TimerResult> {
  const result: TimerResult = {
    movedToGanados: 0,
    movedToPerdidos: 0,
    taggedNuevo: 0,
    rotatedViejo: 0,
  }
  const now = new Date()

  // ---- stage + tag lookups -------------------------------------------
  const { data: stages } = await db
    .from('pipeline_stages')
    .select('id, pipeline_id, name')
    .in('name', ['Nuevos Leads', 'Enviado', 'Ganados', 'Perdidos'])
  const enviadoIds = ((stages ?? []) as StageRow[]).filter((s) => s.name === 'Enviado')
  const nuevosLeadIds = ((stages ?? []) as StageRow[]).filter(
    (s) => s.name === 'Nuevos Leads',
  )
  const ganadosByPipeline = new Map<string, string>()
  const perdidosByPipeline = new Map<string, string>()
  for (const s of (stages ?? []) as StageRow[]) {
    if (s.name === 'Ganados') ganadosByPipeline.set(s.pipeline_id, s.id)
    if (s.name === 'Perdidos') perdidosByPipeline.set(s.pipeline_id, s.id)
  }

  const { data: tagRows } = await db
    .from('tags')
    .select('id, name')
    .in('name', ['Cliente nuevo', 'Cliente viejo'])
  const tagNuevo = (tagRows ?? []).find((t) => t.name === 'Cliente nuevo')?.id as
    | string
    | undefined
  const tagViejo = (tagRows ?? []).find((t) => t.name === 'Cliente viejo')?.id as
    | string
    | undefined

  // ---- 1) Enviado → Ganados after 5 business days --------------------
  try {
    if (enviadoIds.length > 0) {
      const { data: shipped } = await db
        .from('deals')
        .select('id, pipeline_id, stage_entered_at')
        .in('stage_id', enviadoIds.map((s) => s.id))
        .not('stage_entered_at', 'is', null)
        .limit(500)
      for (const d of shipped ?? []) {
        if (businessDaysSince(d.stage_entered_at as string, now) < 5) continue
        const target = ganadosByPipeline.get(d.pipeline_id as string)
        if (!target) continue
        const { error } = await db
          .from('deals')
          .update({
            stage_id: target,
            stage_entered_at: now.toISOString(),
            status: 'won',
          })
          .eq('id', d.id as string)
        if (!error) result.movedToGanados++
      }
    }
  } catch (err) {
    console.error('[pipeline-timers] Enviado→Ganados failed:', err)
  }

  // ---- 1b) Nuevos Leads → Perdidos after 5 days with no interest ------
  // A lead that has sat in "Nuevos Leads" for 5+ days never advanced to
  // Negociación — treat it as cold and archive it in Perdidos. The
  // insurance/personal book is explicitly excluded: those contacts are
  // isolated and must never be swept as cold coffee leads.
  try {
    if (nuevosLeadIds.length > 0 && perdidosByPipeline.size > 0) {
      // Contact ids that carry a protected (insurance/personal) tag.
      const { data: protTags } = await db
        .from('tags')
        .select('id')
        .in('name', PROTECTED_TAG_NAMES)
      const protectedTagIds = (protTags ?? []).map((t) => t.id as string)
      const protectedContacts = new Set<string>()
      if (protectedTagIds.length > 0) {
        const { data: protCT } = await db
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', protectedTagIds)
          .limit(5000)
        for (const ct of protCT ?? [])
          if (ct.contact_id) protectedContacts.add(ct.contact_id as string)
      }

      const { data: coldLeads } = await db
        .from('deals')
        .select('id, contact_id, pipeline_id, created_at, stage_entered_at')
        .in('stage_id', nuevosLeadIds.map((s) => s.id))
        .limit(1000)
      for (const d of coldLeads ?? []) {
        const anchor = (d.stage_entered_at as string) || (d.created_at as string)
        if (daysSince(anchor, now) < 5) continue
        if (d.contact_id && protectedContacts.has(d.contact_id as string)) continue
        const target = perdidosByPipeline.get(d.pipeline_id as string)
        if (!target) continue
        const { error } = await db
          .from('deals')
          .update({
            stage_id: target,
            stage_entered_at: now.toISOString(),
            status: 'lost',
          })
          .eq('id', d.id as string)
        if (!error) result.movedToPerdidos++
      }
    }
  } catch (err) {
    console.error('[pipeline-timers] Nuevos Leads→Perdidos failed:', err)
  }

  // ---- 2) First real win → "Cliente nuevo" ---------------------------
  // Only deals with a real sale date (sold_at) count; the historical
  // Kommo import has no sold_at, so it can never be mis-tagged here.
  try {
    if (tagNuevo && tagViejo && ganadosByPipeline.size > 0) {
      const since = new Date(now.getTime() - 90 * 86_400_000).toISOString()
      const { data: wonDeals } = await db
        .from('deals')
        .select('contact_id')
        .in('stage_id', [...ganadosByPipeline.values()])
        .not('sold_at', 'is', null)
        .gte('sold_at', since)
        .not('contact_id', 'is', null)
        .limit(1000)
      const contactIds = [...new Set((wonDeals ?? []).map((d) => d.contact_id as string))]
      for (const cid of contactIds) {
        const { data: existing } = await db
          .from('contact_tags')
          .select('tag_id')
          .eq('contact_id', cid)
          .in('tag_id', [tagNuevo, tagViejo])
          .limit(1)
        if (existing && existing.length > 0) continue // already classified
        const { error } = await db
          .from('contact_tags')
          .insert({ contact_id: cid, tag_id: tagNuevo })
        if (!error) result.taggedNuevo++
      }
    }
  } catch (err) {
    console.error('[pipeline-timers] Cliente nuevo tagging failed:', err)
  }

  // ---- 3) "Cliente nuevo" → "Cliente viejo" after 30 days ------------
  // The contact_tags row's created_at is the immutable start of the
  // 30-day clock; the analytics chart does NOT depend on this tag (it
  // uses each contact's first sold_at), so rotating never erases history.
  try {
    if (tagNuevo && tagViejo) {
      const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString()
      const { data: stale } = await db
        .from('contact_tags')
        .select('id, contact_id')
        .eq('tag_id', tagNuevo)
        .lte('created_at', cutoff)
        .limit(500)
      for (const row of stale ?? []) {
        await db
          .from('contact_tags')
          .upsert(
            { contact_id: row.contact_id as string, tag_id: tagViejo },
            { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
          )
        const { error } = await db.from('contact_tags').delete().eq('id', row.id as string)
        if (!error) result.rotatedViejo++
      }
    }
  } catch (err) {
    console.error('[pipeline-timers] nuevo→viejo rotation failed:', err)
  }

  return result
}
