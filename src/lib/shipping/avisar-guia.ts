import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
import { isBusinessHoursGT } from '@/lib/crm/pipeline-timers'
import { loadSheetsWebhook } from '@/lib/sheets/webhook-config'

// ============================================================
// Aviso de guia al cliente.
//
// SOLO se avisa cuando se cumplen LAS DOS condiciones: hay numero de
// guia Y el pedido esta en "Enviado". Si falta una, se espera.
//
// El "Enviado" que vale es el de la COLUMNA B DE LA HOJA, no la etapa
// del CRM. La etapa del CRM se pone en "Enviado" sola al confirmar el
// pago, asi que no dice nada sobre el paquete. La columna B la mueven a
// mano los muchachos de la tostaduria cuando le entregan la caja a
// Cargo Expreso: ese es el detonador.
//
// Tampoco alcanza con tener guia: la tostaduria imprime la guia antes
// de despachar. Lo comprobamos caro: mirando la etapa del CRM les
// llego el aviso a Julia Martin y a Chin Chen Liu con su pedido
// todavia "En proceso" en la hoja.
//
// Ojo con las recompras: el CRM reusa el mismo deal, asi que un cliente
// puede tener DOS filas en la hoja con el mismo deal_id — la vieja en
// "Enviado" y la nueva en "En proceso". Por eso la fila no se busca por
// deal_id solo, sino por deal_id + el numero de guia que se va a avisar.
// Con Chin Chen Liu pasa exactamente eso hoy (filas 5 y 18).
//
// La ventana de 24h de WhatsApp la abre UNICAMENTE el cliente cuando
// escribe. Mandar una plantilla NO la abre. Por eso:
//   • ventana abierta  -> texto libre (gratis, y se puede escribir todo)
//   • ventana cerrada  -> plantilla de utilidad que YA LLEVA la guia
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
/** El unico estado de la hoja que autoriza el aviso. */
const ESTADO_QUE_AVISA = 'enviado'
const VENTANA_HORAS = 24
const MAX_POR_CORRIDA = 25

export interface ResultadoAvisos {
  enviados: number
  fallados: number
  /** Tienen guia pero la hoja todavia no dice "Enviado". */
  esperando: number
}

/** Una fila de la hoja, tal como la devuelve la accion `estado`. */
interface FilaHoja {
  deal_id: string
  estado: string
  guia: string
  fila: number
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
    `¡Hola ${nombre}! Su pedido ya va en camino 📦\n\n` +
    `Su número de guía de Cargo Expreso es *${guia}*.\n\n` +
    `Puede seguirlo aquí: ${LINK_RASTREO} ☕🤗`
  )
}

/**
 * Le pregunta a la hoja el estado de estos pedidos. Una sola llamada
 * para todos.
 *
 * Devuelve null cuando la hoja no contesta. null NO es "no esta
 * enviado": es "no se sabe", y sin saber no se avisa. Preferimos que un
 * aviso salga tarde a que salga antes de que el paquete exista.
 */
async function estadosDeLaHoja(
  db: SupabaseClient,
  accountId: string,
  dealIds: string[],
): Promise<FilaHoja[] | null> {
  if (dealIds.length === 0) return []

  const cfg = await loadSheetsWebhook(db, accountId)
  if (!cfg) return null
  const { url, token } = cfg

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action: 'estado', deal_ids: dealIds }),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return null

    const json = (await res.json()) as { ok?: boolean; filas?: FilaHoja[] }
    if (!json.ok || !Array.isArray(json.filas)) return null
    return json.filas
  } catch (err) {
    console.error('[guia-aviso] la hoja no contesto:', err)
    return null
  }
}

export async function avisarGuiasPendientes(
  db: SupabaseClient,
): Promise<ResultadoAvisos> {
  const res: ResultadoAvisos = { enviados: 0, fallados: 0, esperando: 0 }

  // Le escribe a clientes: respeta el horario habil.
  if (!isBusinessHoursGT()) return res

  try {
    // Candidatos: tienen guia y todavia no se les aviso. La etapa del
    // CRM no se mira — no significa nada para el envio.
    const { data: pendientes } = await db
      .from('deals')
      .select('id, account_id, contact_id, tracking_number')
      .not('tracking_number', 'is', null)
      .is('tracking_notified_at', null)
      .not('contact_id', 'is', null)
      .limit(MAX_POR_CORRIDA)

    const lista = pendientes ?? []
    if (lista.length === 0) return res

    // La hoja se consulta por cuenta: cada una tiene su webhook.
    const porCuenta = new Map<string, FilaHoja[] | null>()
    for (const cuenta of new Set(lista.map((d) => String(d.account_id)))) {
      porCuenta.set(
        cuenta,
        await estadosDeLaHoja(
          db,
          cuenta,
          lista.filter((d) => d.account_id === cuenta).map((d) => String(d.id)),
        ),
      )
    }

    const ahora = Date.now()

    for (const deal of lista) {
      const guia = String(deal.tracking_number)
      const filas = porCuenta.get(String(deal.account_id))

      // La hoja no contesto: no se sabe, no se avisa, se reintenta.
      if (filas === null || filas === undefined) {
        res.esperando++
        continue
      }

      // deal_id + guia. Solo el par identifica la venta de esta guia
      // cuando el cliente ya compro antes con el mismo deal.
      const fila = filas.find(
        (f) => f.deal_id === String(deal.id) && f.guia === guia,
      )

      if (!fila || fila.estado.trim().toLowerCase() !== ESTADO_QUE_AVISA) {
        res.esperando++
        continue
      }

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
