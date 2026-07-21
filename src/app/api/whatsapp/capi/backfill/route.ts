import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendPurchaseEvent } from '@/lib/meta/capi'

interface BackfillEvent {
  event_id: string
  value: number
  currency?: string
  phone?: string
  email?: string
  first_name?: string
  last_name?: string
  /** Unix seconds of the sale; must be within the last 7 days. */
  event_time?: number
  /** fb.1.<ts>.<fbclid> cookie value rebuilt from an order's fbclid. */
  fbc?: string
  source_url?: string
}

/**
 * POST /api/whatsapp/capi/backfill  (admin)
 *
 * Body: { events: BackfillEvent[] }  (max 50)
 *
 * Re-sends Purchase events to the Meta dataset for sales that happened in
 * the last 7 days but never reached the pixel — e.g. Shopify cash-on-
 * delivery orders (the browser pixel only fires on PAID checkouts) or CRM
 * sales confirmed before server-side signals existed. Events carry hashed
 * advanced-matching identifiers so Meta can credit the right campaign.
 * `event_id` dedupes: re-sending the same sale never double-counts.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as {
      events?: BackfillEvent[]
    } | null
    const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : []
    if (events.length === 0) {
      return NextResponse.json({ error: 'events[] is required' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: config } = await db
      .from('whatsapp_config')
      .select('capi_dataset_id, capi_access_token, access_token')
      .eq('account_id', accountId)
      .maybeSingle()

    const datasetId = config?.capi_dataset_id
    if (!config || !datasetId) {
      return NextResponse.json({ error: 'CAPI no configurado' }, { status: 400 })
    }

    let accessToken: string
    try {
      accessToken = config.capi_access_token
        ? decrypt(config.capi_access_token)
        : decrypt(config.access_token)
    } catch {
      return NextResponse.json({ error: 'token_decrypt_failed' }, { status: 500 })
    }

    const results = []
    for (const ev of events) {
      if (!ev || typeof ev.event_id !== 'string' || !ev.event_id) {
        results.push({ ok: false, error: 'missing event_id' })
        continue
      }
      const r = await sendPurchaseEvent({
        datasetId,
        accessToken,
        value: Number(ev.value) || 0,
        currency: ev.currency || 'GTQ',
        phone: ev.phone ?? null,
        email: ev.email ?? null,
        firstName: ev.first_name ?? null,
        lastName: ev.last_name ?? null,
        fbc: ev.fbc ?? null,
        eventId: ev.event_id,
        eventTime: ev.event_time ?? null,
        eventSourceUrl: ev.source_url ?? null,
      })
      results.push({ event_id: ev.event_id, ok: r.ok, error: r.error })
    }

    const sent = results.filter((r) => r.ok).length
    return NextResponse.json({ ok: true, sent, total: results.length, results })
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status?: number }).status ?? 500
        : 500
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status },
    )
  }
}
