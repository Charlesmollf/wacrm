import type { SupabaseClient } from '@supabase/supabase-js'
import { parseGuiaPdf, type GuiaPdf } from './parse-guia-pdf'

/**
 * Empareja el PDF de una guia de Cargo Expreso con su pedido y escribe el
 * numero de guia en la hoja y en `deals.tracking_number`.
 *
 * LA REGLA DE ORO: si no se puede saber con certeza a que pedido pertenece
 * una guia, NO se escribe nada. Se deja el hueco y se avisa. Mandarle a un
 * cliente el rastreo del paquete de otro es peor que no mandarle nada.
 *
 * Todo es best-effort: si algo falla, el mensaje del PDF ya quedo guardado
 * en la conversacion y la tostaduria puede escribir la guia a mano.
 */

/** Etapas donde un pedido puede estar esperando su guia. */
const ETAPAS_CON_ENVIO = ['Enviado', 'Pedidos Confirmados']

type Resultado =
  | { ok: true; dealId: string; guia: string; fila?: number }
  | { ok: false; motivo: string; datos?: GuiaPdf }

async function avisar(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  titulo: string,
  cuerpo: string,
  contactId?: string | null,
) {
  const { error } = await db.from('notifications').insert({
    account_id: accountId,
    user_id: userId,
    type: 'guia_sin_pareja',
    title: titulo,
    body: cuerpo,
    contact_id: contactId ?? null,
  })
  if (error) {
    console.error('[guia] no se pudo crear la notificacion:', error.message)
  }
}

/** Manda la guia a la hoja usando la accion `guia` del Apps Script. */
async function escribirEnHoja(
  db: SupabaseClient,
  accountId: string,
  dealId: string,
  guia: string,
): Promise<{ ok: boolean; fila?: number; error?: string }> {
  const { data: cfg } = await db
    .from('whatsapp_config')
    .select('sheets_webhook_url, sheets_webhook_token')
    .eq('account_id', accountId)
    .maybeSingle()

  const url = cfg?.sheets_webhook_url as string | undefined
  const token = cfg?.sheets_webhook_token as string | undefined
  if (!url || !token) return { ok: false, error: 'hoja no configurada' }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, accion: 'guia', deal_id: dealId, no_guia: guia }),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
    const texto = await res.text().catch(() => '')
    if (!res.ok) return { ok: false, error: `http ${res.status}` }

    const json = JSON.parse(texto) as { ok?: boolean; fila?: number; error?: string }
    if (!json.ok) return { ok: false, error: json.error ?? 'error del script' }
    return { ok: true, fila: json.fila }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'excepcion' }
  }
}

export async function procesarGuiaPdf(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  pdf: Buffer,
): Promise<Resultado> {
  const datos = parseGuiaPdf(pdf)
  if (!datos) {
    await avisar(
      db,
      accountId,
      userId,
      'Llego una guia que no se pudo leer',
      'El PDF no tiene el formato esperado de Cargo Expreso. Hay que escribir la guia a mano en la hoja.',
    )
    return { ok: false, motivo: 'no se pudo leer el PDF' }
  }

  const { guia, telefono, destinatario } = datos
  const resumen = `Guia ${guia} · ${destinatario} · ${telefono}`

  // 1) El contacto, por telefono.
  const { data: contacto } = await db
    .from('contacts')
    .select('id, name')
    .eq('account_id', accountId)
    .eq('phone', telefono)
    .maybeSingle()

  if (!contacto) {
    await avisar(
      db,
      accountId,
      userId,
      'Guia sin cliente',
      `${resumen}. Ningun contacto tiene ese telefono. Se dejo el hueco en la hoja.`,
    )
    return { ok: false, motivo: 'contacto no encontrado', datos }
  }

  // 2) Sus pedidos que todavia esperan guia.
  const { data: etapas } = await db
    .from('pipeline_stages')
    .select('id, name')
    .in('name', ETAPAS_CON_ENVIO)

  const idsEtapas = (etapas ?? []).map((e: { id: string }) => e.id)

  const { data: candidatos } = await db
    .from('deals')
    .select('id, sold_at, address')
    .eq('contact_id', contacto.id)
    .in('stage_id', idsEtapas)
    .is('tracking_number', null)
    .order('sold_at', { ascending: false })

  const lista = candidatos ?? []

  if (lista.length === 0) {
    await avisar(
      db,
      accountId,
      userId,
      'Guia sin pedido',
      `${resumen}. ${contacto.name} no tiene ningun pedido esperando guia. Se dejo el hueco en la hoja.`,
      contacto.id,
    )
    return { ok: false, motivo: 'sin pedido candidato', datos }
  }

  // Con mas de un pedido abierto no se adivina. Se avisa y listo.
  if (lista.length > 1) {
    await avisar(
      db,
      accountId,
      userId,
      'Guia con mas de un pedido posible',
      `${resumen}. ${contacto.name} tiene ${lista.length} pedidos esperando guia, asi que no se puede saber cual es. Hay que escribirla a mano.`,
      contacto.id,
    )
    return { ok: false, motivo: 'mas de un candidato', datos }
  }

  const deal = lista[0]

  // 3) Primero la hoja. Si la hoja no acepta, no se toca la base: asi las
  //    dos quedan diciendo lo mismo.
  const hoja = await escribirEnHoja(db, accountId, deal.id, guia)
  if (!hoja.ok) {
    await avisar(
      db,
      accountId,
      userId,
      'No se pudo escribir la guia en la hoja',
      `${resumen}. La hoja respondio: ${hoja.error}. Hay que escribirla a mano.`,
      contacto.id,
    )
    return { ok: false, motivo: `hoja: ${hoja.error}`, datos }
  }

  const { error: errUpd } = await db
    .from('deals')
    .update({ tracking_number: guia })
    .eq('id', deal.id)

  if (errUpd) {
    console.error('[guia] la hoja quedo bien pero deals no:', errUpd.message)
    await avisar(
      db,
      accountId,
      userId,
      'La guia entro a la hoja pero no a la base',
      `${resumen}. Fila ${hoja.fila}. El aviso al cliente no va a salir solo.`,
      contacto.id,
    )
    return { ok: false, motivo: 'update de deals fallo', datos }
  }

  console.log(`[guia] ${guia} -> deal ${deal.id} (fila ${hoja.fila})`)
  return { ok: true, dealId: deal.id, guia, fila: hoja.fila }
}
