import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
import { isBusinessHoursGT } from '@/lib/crm/pipeline-timers'

// ============================================================
// Aviso de guia al cliente.
//
// Cuando un pedido esta en "Enviado" y ya tiene numero de guia, se le
// manda al cliente su numero y el link de rastreo. Un solo aviso por
// pedido.
//
// La ventana de 24h de WhatsApp la abre UNICAMENTE el cliente cuando
// escribe. Mandar una plantilla NO la abre. Por eso:
//   - ventana abierta  -> texto libre (gratis, y se puede escribir todo)
//   - ventana cerrada  -> plantilla de utilidad que YA LLEVA la guia
//     adentro. No sirve "plantilla primero y despues el texto": el
//     segundo mensaje lo rechaza Meta porque la ventana sigue cerrada.
//
// El candado es `deals.tracking_notified_at`, columna propia. NO se usa
// `confirm_requested_at`, que es el candado del pedido de confirmacion
// de pago: compartirla mezclaria los dos flujos.
// ============================================================

/** Plantilla de utilidad con {{1}} nombre y {{2}} numero de guia. */
const PLANTILLA = 'guia_envio_cargo_expreso'
const IDIOMA_PLANTILLA = 'es'

const LINK_RASTREO = 'https://cargoexpreso.com/tracking/'
// Tener numero de guia YA significa que el paquete salio, sin importar
// en que columna del embudo quedo la tarjeta. Antes esto solo miraba
// 'Enviado' y a Luisa Fernanda nunca le llego su aviso: su pedido se
// quedo en 'Pedidos Confirmados' aunque ya tenia guia. Se usan las
// mismas dos etapas con las que se acepta escribir la guia.
const ETAPAS_AVISABLES = ['Enviado', 'Pedidos Confirmados']
const VENTANA_HORAS = 24
const MAX_POR_CORRIDA = 25

export interface ResultadoAvisos {
  enviados: number
  fallados: number
}

function ventanaAbierta(lastInboundAt: string | null, ahora: number): boolean {
  if (!lastInboundAt) return false
  const t = new Date(lastInboundAt).getTime()
  if (Number.isNaN(t)) return false
  return (ahora - t) / 3_600_000 < VENTANA_HORAS
}

/** Primer nombre, para que el saludo no diga "Hola Carlos Pirela Lopez". */
function primerNombre(nombre: string | null): string {
  const limpio = String(nombre ?? '').trim()
  if (!limpio) return 'estimado'
  return limpio.split(/\s+/)[0]
}

function textoLibre(nombre: string, guia: string): string {
  return (
    `Hola ${nombre}! Su pedido ya va en camino 📦\n\n` +
    `Su número de guía de Cargo Expreso es *${guia}*.\n\n` +
    `Puede seguirlo aquí: ${LINK_RASTREO} ☕🤗`
  )
}

export async function avisarGuiasPendientes(
  db: SupabaseClient,
): Promise<ResultadoAvisos> {
  const res: ResultadoAvisos = { enviados: 0, fallados: 0 }

  // Le escribe a clientes: respeta el horario habil.
  if (!isBusinessHoursGT()) return res

  try {
    const { data: etapas } = await db
      .from('pipeline_stages')
      .select('id')
      .in('name', ETAPAS_AVISABLES)
    const idsEtapas = (etapas ?? []).map((e: { id: string }) => e.id)
    if (idsEtapas.length === 0) return res

    const { data: pendientes } = await db
      .from('deals')
      .select('id, account_id, contact_id, tracking_number')
      .in('stage_id', idsEtapas)
      .not('tracking_number', 'is', null)
      .is('tracking_notified_at', null)
      .not('contact_id', 'is', null)
      .limit(MAX_POR_CORRIDA)

    const ahora = Date.now()

    for (const deal of pendientes ?? []) {
      const { data: contacto } = await db
        .from('contacts')
        .select('id, name')
        .eq('id', deal.contact_id)
        .maybeSingle()
      if (!contacto) continue

      const { data: convs } = await db
        .from('conversations')
        .select('id, last_inbound_at')
        .eq('contact_id', deal.contact_id)
        .eq('account_id', deal.account_id)
        .order('created_at', { ascending: true })
        .limit(1)
      const conv = (convs ?? [])[0]
      if (!conv) continue

      const { data: cfg } = await db
        .from('whatsapp_config')
        .select('user_id')
        .eq('account_id', deal.account_id)
        .maybeSingle()
      const ownerUserId = cfg?.user_id as string | undefined
      if (!ownerUserId) continue

      // Se reclama la fila ANTES de mandar. El `.is(null)` hace que dos
      // corridas simultaneas no puedan quedarse las dos con el mismo
      // pedido: la segunda no actualiza ninguna fila y se saltea.
      // Si el envio falla despues, se libera abajo y se reintenta en la
      // proxima corrida.
      const { data: reclamado } = await db
        .from('deals')
        .update({ tracking_notified_at: new Date().toISOString() })
        .eq('id', deal.id)
        .is('tracking_notified_at', null)
        .select('id')
      if (!reclamado || reclamado.length === 0) continue

      const nombre = primerNombre(contacto.name)
      const guia = String(deal.tracking_number)

      try {
        if (ventanaAbierta(conv.last_inbound_at as string | null, ahora)) {
          await engineSendText({
            accountId: deal.account_id,
            userId: ownerUserId,
            conversationId: conv.id,
            contactId: deal.contact_id,
            text: textoLibre(nombre, guia),
          })
        } else {
          await engineSendTemplate({
            accountId: deal.account_id,
            userId: ownerUserId,
            conversationId: conv.id,
            contactId: deal.contact_id,
            templateName: PLANTILLA,
            language: IDIOMA_PLANTILLA,
            params: [nombre, guia],
          })
        }
        res.enviados++
      } catch (err) {
        // Se libera el candado para reintentar en la proxima corrida.
        await db
          .from('deals')
          .update({ tracking_notified_at: null })
          .eq('id', deal.id)
        res.fallados++
        console.error(`[guia-aviso] fallo el aviso del deal ${deal.id}:`, err)
      }
    }
  } catch (err) {
    console.error('[guia-aviso] avisarGuiasPendientes fallo:', err)
  }

  return res
}
