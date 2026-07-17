import { createHash } from 'crypto'

/**
 * Meta Conversions API — server-side Purchase events for Click-to-WhatsApp.
 *
 * When a customer taps a "Click to WhatsApp" ad, Meta attaches a `referral`
 * object (with a `ctwa_clid`) to their first inbound message. We stash that
 * click id on the conversation. When the owner later confirms the payment,
 * we fire a server-side `Purchase` event back to Meta's dataset so the
 * campaign learns which conversations turned into real, paid sales and can
 * optimize toward them (action_source = business_messaging).
 *
 * Best-effort by contract: every error is swallowed and returned as a
 * result object — a failed signal must never block the payment being marked
 * as paid.
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
  /** Click id from the Click-to-WhatsApp referral, when the lead came from an ad. */
  ctwaClid?: string | null
  /** Stable id so re-confirming the same deal dedupes instead of double-counting. */
  eventId: string
  /** WhatsApp Business Account id — helps Meta bind the event to the channel. */
  wabaId?: string | null
}

export interface SendPurchaseEventResult {
  ok: boolean
  /** Whether the event carried a ctwa_clid (i.e. is ad-attributable). */
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
    ctwaClid,
    eventId,
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
    if (wabaId) userData.whatsapp_business_account_id = wabaId

    const payload = {
      data: [
        {
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          user_data: userData,
          custom_data: {
            currency: currency || 'GTQ',
            value: Number(value) || 0,
          },
        },
      ],
      access_token: accessToken,
    }

    const url = `https://graph.facebook.com/${META_API_VERSION}/${datasetId}/events`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
    const json = (await res.json().catch(() => null)) as {
      error?: { message?: string; fbtrace_id?: string }
    } | null

    if (!res.ok || json?.error) {
      return {
        ok: false,
        attributed,
        status: res.status,
        error: json?.error?.message ?? `HTTP ${res.status}`,
        fbtrace_id: json?.error?.fbtrace_id,
      }
    }
    return { ok: true, attributed, status: res.status }
  } catch (err) {
    return {
      ok: false,
      attributed,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
