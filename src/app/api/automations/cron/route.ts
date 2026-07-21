import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { drainScheduledBroadcasts } from '@/lib/whatsapp/scheduled-broadcast'
import { isBusinessHoursGT, runPipelineTimers } from '@/lib/crm/pipeline-timers'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * Business-hours guard: automated CUSTOMER-FACING sends (scheduled
 * broadcasts + pending automation steps, e.g. the 24h follow-up
 * template) only go out Mon-Fri 07:00-21:00 Guatemala time. Outside
 * that window they stay queued and the next in-window run delivers
 * them — nobody gets a template at 3am. Silent pipeline timers
 * (Enviado→Ganados, Cliente nuevo→viejo) run on every invocation:
 * they move cards and tags, never message anyone.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  // Silent pipeline clockwork — no customer messages, runs 24/7.
  let timers: unknown = null
  try {
    timers = await runPipelineTimers(admin)
  } catch (e) {
    console.error('[cron] pipeline timers failed:', e)
  }

  const inBusinessHours = isBusinessHoursGT()
  if (!inBusinessHours) {
    // Everything below sends messages to customers — defer it all.
    return NextResponse.json({
      processed: 0,
      broadcastsSent: 0,
      deferred: true,
      timers,
    })
  }

  // Send any due scheduled broadcasts (separate from automations).
  let broadcastsSent = 0
  try {
    broadcastsSent = await drainScheduledBroadcasts(admin)
  } catch (e) {
    console.error('[cron] scheduled broadcasts failed:', e)
  }

  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!due || due.length === 0)
    return NextResponse.json({ processed: 0, broadcastsSent, timers })

  let processed = 0
  for (const row of due) {
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
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
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

  return NextResponse.json({ processed, broadcastsSent, timers })
}
