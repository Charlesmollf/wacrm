import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { isBusinessHoursGT } from './pipeline-timers'

// ============================================================
// Seguimiento proactivo dentro de la ventana de 24h.
//
// Un lead que escribió, recibió respuesta del bot y NO volvió a
// contestar se enfría en silencio hasta que la ventana de WhatsApp
// (24h desde su último mensaje) se cierra — y ahí ya no se le puede
// escribir en texto libre, solo con plantilla. Este barrido detecta a
// esos leads mientras la ventana AÚN está abierta y les manda UN
// recordatorio cálido para retomar y empujar la venta.
//
// Reglas:
//   • Solo leads en "Nuevos Leads" o "Negociación" (no cerrados).
//   • Silencio del cliente entre MIN y MAX horas (aún en ventana).
//   • Lo último en el chat fue NUESTRA respuesta (el cliente no ha
//     escrito de nuevo) — si el cliente escribió, el bot lo atiende.
//   • Un solo recordatorio por lead: se marca con la etiqueta
//     "seguimiento-24h". Si el cliente vuelve a escribir, se le quita
//     la marca para poder darle seguimiento otra vez si se enfría.
//   • Excluye clientes existentes (viejo/nuevo) y el libro de seguros.
//   • Solo en horario hábil (L-V 7-21 GT).
// ============================================================

const FOLLOWUP_TAG = 'seguimiento-24h'
const EXCLUDE_TAG_NAMES = [
  'otro-negocio-seguros',
  'seguros',
  'fianzas',
  'personal',
  'persona-clave',
  'Cliente viejo',
  'Cliente nuevo',
]
// Ventana de silencio para el recordatorio (horas desde el último
// mensaje del cliente). Amplia por si el cron corre esporádicamente,
// pero siempre antes de que se cierre la ventana de 24h.
const MIN_HOURS = 12
const MAX_HOURS = 23.5
const MAX_PER_RUN = 25

// Recordatorios cálidos, rotados para no sonar robótico. Texto libre
// (permitido dentro de la ventana de 24h). Cuando el cliente responde,
// la IA retoma con todo el contexto y cierra.
const NUDGES = [
  '¡Hola! 👋 ¿Sigue pensando en su café? Con gusto le ayudo a elegir el ideal para usted ☕ ¿Le gusta más dulce (chocolate/caramelo) o más frutal y ácido?',
  '¡Hola de nuevo! 😊 No quería dejarle sin seguimiento. ¿Le comparto los combos más pedidos o le ayudo a armar su pedido? Aquí estoy para servirle ☕',
  '¡Buen día! ☕ Quedé pendiente de usted. ¿Le ayudo a decidir su café o tiene alguna duda? Con gusto le asesoro para que elija el que más le va a gustar 😊',
]

function hoursSince(iso: string | null, now: number): number {
  if (!iso) return Infinity
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return Infinity
  return (now - t) / 3_600_000
}

interface FollowupResult {
  sent: number
  reset: number
}

export async function runLeadFollowups(db: SupabaseClient): Promise<FollowupResult> {
  const result: FollowupResult = { sent: 0, reset: 0 }
  // Manda mensajes a clientes → respeta el horario hábil.
  if (!isBusinessHoursGT()) return result
  const now = Date.now()

  try {
    const { data: stages } = await db
      .from('pipeline_stages')
      .select('id, name')
      .in('name', ['Nuevos Leads', 'Negociación'])
    const stageIds = (stages ?? []).map((s) => s.id as string)
    if (stageIds.length === 0) return result

    const { data: leadDeals } = await db
      .from('deals')
      .select('account_id, contact_id')
      .in('stage_id', stageIds)
      .not('contact_id', 'is', null)
      .limit(2000)
    if (!leadDeals || leadDeals.length === 0) return result

    // Agrupar por cuenta.
    const byAccount = new Map<string, Set<string>>()
    for (const d of leadDeals) {
      const acct = d.account_id as string
      const cid = d.contact_id as string
      if (!byAccount.has(acct)) byAccount.set(acct, new Set())
      byAccount.get(acct)!.add(cid)
    }

    for (const [accountId, contactSet] of byAccount) {
      if (result.sent >= MAX_PER_RUN) break
      const contactIds = [...contactSet]

      // Dueño de la cuenta (para el user_id del envío).
      const { data: cfg } = await db
        .from('whatsapp_config')
        .select('user_id')
        .eq('account_id', accountId)
        .maybeSingle()
      const ownerUserId = cfg?.user_id as string | undefined
      if (!ownerUserId) continue

      // Etiquetas: crear/obtener la de seguimiento; resolver excluidas.
      const { data: acctTags } = await db
        .from('tags')
        .select('id, name')
        .eq('account_id', accountId)
      let followupTagId = (acctTags ?? []).find((t) => t.name === FOLLOWUP_TAG)?.id as
        | string
        | undefined
      if (!followupTagId) {
        const { data: created } = await db
          .from('tags')
          .insert({ account_id: accountId, user_id: ownerUserId, name: FOLLOWUP_TAG, color: '#f59e0b' })
          .select('id')
          .maybeSingle()
        followupTagId = created?.id as string | undefined
      }
      if (!followupTagId) continue
      const excludeTagIds = (acctTags ?? [])
        .filter((t) => EXCLUDE_TAG_NAMES.includes(t.name as string))
        .map((t) => t.id as string)

      // Contactos excluidos (clientes/seguros) y ya-seguidos.
      const excludedContacts = new Set<string>()
      if (excludeTagIds.length > 0) {
        const { data: ex } = await db
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', excludeTagIds)
          .in('contact_id', contactIds)
        for (const r of ex ?? []) if (r.contact_id) excludedContacts.add(r.contact_id as string)
      }
      const { data: already } = await db
        .from('contact_tags')
        .select('contact_id, id')
        .eq('tag_id', followupTagId)
        .in('contact_id', contactIds)
      const alreadyTagged = new Map<string, string>()
      for (const r of already ?? []) alreadyTagged.set(r.contact_id as string, r.id as string)

      // Conversaciones de estos leads.
      const { data: convs } = await db
        .from('conversations')
        .select('id, contact_id, last_inbound_at, last_outbound_at')
        .in('contact_id', contactIds)
        .order('last_message_at', { ascending: false })
        .limit(5000)

      const seen = new Set<string>()
      for (const conv of convs ?? []) {
        if (result.sent >= MAX_PER_RUN) break
        const cid = conv.contact_id as string | null
        if (!cid || seen.has(cid)) continue
        seen.add(cid)

        const lastIn = conv.last_inbound_at as string | null
        const lastOut = conv.last_outbound_at as string | null
        const customerWroteLast =
          !!lastIn && (!lastOut || new Date(lastIn).getTime() > new Date(lastOut).getTime())

        // El cliente volvió a escribir → resetear la marca para poder
        // darle seguimiento otra vez más adelante; el bot lo atiende.
        if (customerWroteLast) {
          const tagRowId = alreadyTagged.get(cid)
          if (tagRowId) {
            const { error } = await db.from('contact_tags').delete().eq('id', tagRowId)
            if (!error) result.reset++
          }
          continue
        }

        // Candidato a recordatorio.
        if (alreadyTagged.has(cid)) continue
        if (excludedContacts.has(cid)) continue
        const h = hoursSince(lastIn, now)
        if (h < MIN_HOURS || h > MAX_HOURS) continue

        const text = NUDGES[(cid.charCodeAt(0) + cid.length) % NUDGES.length]
        try {
          await engineSendText({
            accountId,
            userId: ownerUserId,
            conversationId: conv.id as string,
            contactId: cid,
            text,
            aiGenerated: true,
          })
          await db
            .from('contact_tags')
            .insert({ contact_id: cid, tag_id: followupTagId })
          result.sent++
        } catch (sendErr) {
          console.error('[lead-followup] send failed for', cid, sendErr)
        }
      }
    }
  } catch (err) {
    console.error('[lead-followup] runLeadFollowups failed:', err)
  }

  return result
}
