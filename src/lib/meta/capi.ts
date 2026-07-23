import { createHash } from 'crypto'

/**
 * Meta Conversions API — server-side Purchase events.
 *
 * Two attribution paths:
 *
 * 1) Click-to-WhatsApp (best): when a customer taps a CTWA ad, Meta
 *    attaches a `referral` (with `ctwa_clid`) to their first inbound
 *    message; we stash it on the conversation. Confirming the payment
 *    fires a Purchase with action_source = business_messaging + that
 *    click id — deterministic attribution.
 *
 * 2) Advanced matching (fallback): sales with no ctwa_clid (older
 *    conversations, repeat buyers, Shopify orders) are still sent, as
 *    action_source = website with hashed phone/email/name. Meta matches
 *    the person against ad viewers/clickers inside the attribution
 *    window — so purchases from people who saw the ad but entered
 *    through an old chat or the store still credit the campaign.
 *
 * Best-effort by contract: every error is swallowed and returned as a
 * result object — a failed signal must never block the payment being
 * marked as paid.
 */

const META_API_VERSION = 'v21.0'

export interface SendPurchaseEventArgs {
  /** Meta dataset (pixel) id the event is written to. */
  datasetId: string
  /** Access token with permission to write events to the dataset. */
  accessToken: string
  /** Sale amount. */
  value: number
  /** ISO currency, e.g. "GTQ". */
  currency: string
  /** Customer phone in E.164-ish digits (no +); hashed before send. */
  phone?: string | null
  /** Customer email; hashed before send (fallback matching). */
  email?: string | null
  /** Customer first/last name; hashed before send (fallback matching). */
  firstName?: string | null
  lastName?: string | null
  /** Click id from the Click-to-WhatsApp referral, when the lead came from an ad. */
  ctwaClid?: string | null
  /** Facebook click cookie value (fb.1.<ts>.<fbclid>) when known — e.g.
   *  rebuilt from a Shopify order's fbclid. Strong web attribution. */
  fbc?: string | null
  /** Stable id so re-confirming the same deal dedupes instead of double-counting. */
  eventId: string
  /** Unix seconds of the actual sale moment; defaults to now. Must be
   *  within the last 7 days per CAPI rules. */
  eventTime?: number | null
  /** Page URL for website-source events (e.g. the store's order page). */
  eventSourceUrl?: string | null
  /** WhatsApp Business Account id — helps Meta bind the event to the channel. */
  wabaId?: string | null
}

export interface SendPurchaseEventResult {
  ok: boolean
  /** Whether the event carried a ctwa_clid (i.e. is deterministically ad-attributable). */
  attributed: boolean
  status?: number
  error?: string
  fbtrace_id?: string
}

/** SHA-256 hex of a normalized value, per Meta's PII hashing requirement. */
function hash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

export async function sendPurchaseEvent(
  args: SendPurchaseEventArgs,
): Promise<SendPurchaseEventResult> {
  const {
    datasetId,
    accessToken,
    value,
    currency,
    phone,
    email,
    firstName,
    lastName,
    ctwaClid,
    fbc,
    eventId,
    eventTime,
    eventSourceUrl,
    wabaId,
  } = args

  const attributed = !!(ctwaClid && ctwaClid.trim())

  try {
    const userData: Record<string, unknown> = {}
    if (attributed) userData.ctwa_clid = ctwaClid
    if (phone) {
      const digits = phone.replace(/[^0-9]/g, '')
      if (digits) userData.ph = [hash(digits)]
    }
    if (email && email.includes('@')) userData.em = [hash(email)]
    if (firstName) userData.fn = [hash(firstName)]
    if (lastName) userData.ln = [hash(lastName)]
    if (fbc) userData.fbc = fbc
    if (attributed && wabaId) userData.whatsapp_business_account_id = wabaId

    // Without any identifier Meta rejects the event outright — bail early
    // with a readable reason instead of a cryptic API error.
    if (Object.keys(userData).length === 0) {
      return { ok: false, attributed, error: 'no user identifiers to match on' }
    }

    const url = `https://graph.facebook.com/${META_API_VERSION}/${datasetId}/events`

    // POST one event object; returns a normalized result.
    const postEvent = async (
      event: Record<string, unknown>,
    ): Promise<{ ok: boolean; status: number; error?: string; fbtrace_id?: string }> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [event], access_token: accessToken }),
        signal: AbortSignal.timeout(10000),
      })
      const json = (await res.json().catch(() => null)) as {
        error?: {
          message?: string
          error_user_title?: string
          error_user_msg?: string
          error_subcode?: number
          fbtrace_id?: string
        }
      } | null
      if (!res.ok || json?.error) {
        const e = json?.error ?? {}
        const detail =
          [e.message, e.error_user_title, e.error_user_msg]
            .filter(Boolean)
            .join(' | ') || `HTTP ${res.status}`
        return { ok: false, status: res.status, error: detail, fbtrace_id: e.fbtrace_id }
      }
      return { ok: true, status: res.status }
    }

    const baseEvent: Record<string, unknown> = {
      event_name: 'Purchase',
      event_time: eventTime && eventTime > 0 ? eventTime : Math.floor(Date.now() / 1000),
      event_id: eventId,
      user_data: userData,
      custom_data: {
        currency: currency || 'GTQ',
        value: Number(value) || 0,
      },
    }

    // Website event (advanced matching) — accepted by any pixel dataset,
    // used as the fallback and for non-CTWA sales.
    const websiteEvent = () => {
      const ud = { ...userData }
      // ctwa_clid / WABA id are only valid on a business_messaging event.
      delete (ud as Record<string, unknown>).ctwa_clid
      delete (ud as Record<string, unknown>).whatsapp_business_account_id
      const ev = { ...baseEvent, user_data: ud, action_source: 'website' as const }
      if (eventSourceUrl) (ev as Record<string, unknown>).event_source_url = eventSourceUrl
      return ev
    }

    if (!attributed) {
      const r = await postEvent(websiteEvent())
      return { ok: r.ok, attributed: false, status: r.status, error: r.error, fbtrace_id: r.fbtrace_id }
    }

    // Attributed CTWA sale: try the deterministic business_messaging path.
    const bmEvent = { ...baseEvent, action_source: 'business_messaging', messaging_channel: 'whatsapp' }
    const r1 = await postEvent(bmEvent)
    if (r1.ok) return { ok: true, attributed: true, status: r1.status }

    // Meta rejects CTWA events when the dataset has no WhatsApp Business
    // Account connected. Until that connection is made in Events Manager,
    // don't lose the sale: retry as a website advanced-matching event so
    // the pixel still gets the Purchase signal (feeds optimization). Full
    // CTWA attribution resumes automatically once the WABA is connected.
    const noWaba = /whatsapp business|business account|sin cuenta de whatsapp|associated/i.test(
      r1.error ?? '',
    )
    if (noWaba) {
      const r2 = await postEvent(websiteEvent())
      // Report attributed=false so the caller/log reflects the fallback.
      return {
        ok: r2.ok,
        attributed: false,
        status: r2.status,
        error: r2.ok ? `ctwa_rejected_fell_back_to_website (${r1.error})` : r2.error,
        fbtrace_id: r2.fbtrace_id,
      }
    }
    return { ok: false, attributed: true, status: r1.status, error: r1.error, fbtrace_id: r1.fbtrace_id }
  } catch (err) {
    return {
      ok: false,
      attributed,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
