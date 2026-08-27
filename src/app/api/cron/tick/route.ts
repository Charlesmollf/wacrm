import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { drainScheduledBroadcasts } from '@/lib/whatsapp/scheduled-broadcast'
import { isBusinessHoursGT, runPipelineTimers } from '@/lib/crm/pipeline-timers'
import { runLeadFollowups } from '@/lib/crm/lead-followup'
import { avisarGuiasPendientes } from '@/lib/shipping/avisar-guia'
import { reconcileCapiPurchases } from '@/lib/crm/capi-reconcile'

export const maxDuration = 60

/**
 * GET /api/cron/tick?token=<uuid>
 *
 * Gemelo de /api/automations/cron, pero autenticado contra un token
 * guardado en la BASE DE DATOS (`app_cron_auth`) en vez de una variable
 * de entorno. Eso permite que **pg_cron dentro de Supabase** despierte
 * al CRM cada pocos minutos: el reloj vive junto a los datos y ya no
 * depende de que corra un runner externo (el cron de GitHub se
 * ejecutaba de forma irregular, cada varias horas).
 *
 * Hace exactamente lo mismo que el cron original:
 *   - Relojería silenciosa del pipeline (mueve tarjetas y etiquetas) 24/7.
 *   - Reconciliación de compras hacia Meta (solo habla con Meta) 24/7.
 *   - Envíos a clientes (difusiones programadas, seguimiento a leads
 *     fríos y pasos pendientes de automatizaciones) SOLO en horario
 *     hábil L-V 07:00–21:00 Guatemala.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const supplied =
    url.searchParams.get('token') ?? request.headers.get('x-cron-token') ?? ''
  if (!supplied) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  const { data: auth } = await admin
    .from('app_cron_auth')
    .select('token')
    .eq('id', 1)
    .maybeSingle()

  const expected = (auth?.token as string | undefined) ?? ''
  // Comparación de longitud constante para no filtrar el token por tiempos.
  const ok =
    expected.length === supplied.length &&
    expected.length > 0 &&
    (() => {
      let diff = 0
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i)
      }
      return diff === 0
    })()
  if (!ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ---- Trabajo silencioso (no le escribe a nadie) — 24/7 -------------
  let timers: unknown = null
  try {
    timers = await runPipelineTimers(admin)
  } catch (e) {
    console.error('[cron/tick] pipeline timers failed:', e)
  }

  let capiReconcile: unknown = null
  try {
    capiReconcile = await reconcileCapiPurchases(admin)
  } catch (e) {
    console.error('[cron/tick] capi reconcile failed:', e)
  }

  // Las difusiones programadas corren aunque sea fuera del horario
  // habil: la hora la eligio el duenio a proposito (ej. sabado 8am).
  // El horario habil frena los mensajes automaticos del bot, no una
  // difusion agendada a mano.
  let broadcastsSent = 0
  try {
    broadcastsSent = await drainScheduledBroadcasts(admin)
  } catch (e) {
    console.error('[cron/tick] scheduled broadcasts failed:', e)
  }

  if (!isBusinessHoursGT()) {
    return NextResponse.json({
      ok: true,
      deferred: true,
      timers,
      capiReconcile,
      processed: 0,
      broadcastsSent,
    })
  }

  let followups: unknown = null
  try {
    followups = await runLeadFollowups(admin)
  } catch (e) {
    console.error('[cron/tick] lead follow-ups failed:', e)
  }

  // Aviso de guia al cliente: pedidos en Enviado que ya tienen numero
  // de guia y todavia no se avisaron. Respeta el horario habil por
  // dentro y nunca lanza.
  let avisosGuia: unknown = null
  try {
    avisosGuia = await avisarGuiasPendientes(admin)
  } catch (e) {
    console.error('[cron/tick] avisos de guia failed:', e)
  }

  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message, timers, capiReconcile, broadcastsSent, followups },
      { status: 500 },
    )
  }

  let processed = 0
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({
    ok: true,
    processed,
    broadcastsSent,
    timers,
    capiReconcile,
    followups,
    avisosGuia,
  })
}
