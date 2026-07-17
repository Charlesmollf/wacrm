import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * Meta Conversions API config for the account.
 *
 * GET  → { dataset_id, has_token }  (never returns the token itself)
 * POST → { dataset_id?, access_token? }  (admin+) — saves the dataset id and,
 *        if a token is supplied, encrypts it into whatsapp_config so the
 *        payment-confirm route can send Purchase events with it.
 */

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('capi_dataset_id, capi_access_token, resend_api_key, alert_email')
      .eq('account_id', accountId)
      .maybeSingle()
    return NextResponse.json({
      dataset_id: data?.capi_dataset_id ?? null,
      has_token: !!data?.capi_access_token,
      alert_email: data?.alert_email ?? null,
      has_resend: !!data?.resend_api_key,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: existing } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!existing) {
      return NextResponse.json(
        { error: 'Configura primero tu conexión de WhatsApp.' },
        { status: 400 },
      )
    }

    const patch: Record<string, string | null> = {}

    if ('dataset_id' in body) {
      const ds =
        typeof body.dataset_id === 'string' ? body.dataset_id.trim() : ''
      patch.capi_dataset_id = ds || null
    }

    if ('access_token' in body) {
      const raw =
        typeof body.access_token === 'string' ? body.access_token.trim() : ''
      if (raw) {
        try {
          patch.capi_access_token = encrypt(raw)
        } catch {
          return NextResponse.json(
            { error: 'No se pudo encriptar el token (revisa ENCRYPTION_KEY).' },
            { status: 500 },
          )
        }
      } else {
        // Empty string clears the dedicated token (falls back to WA token).
        patch.capi_access_token = null
      }
    }

    if ('alert_email' in body) {
      const em = typeof body.alert_email === 'string' ? body.alert_email.trim() : ''
      patch.alert_email = em || null
    }

    if ('resend_api_key' in body) {
      const raw =
        typeof body.resend_api_key === 'string' ? body.resend_api_key.trim() : ''
      if (raw) {
        try {
          patch.resend_api_key = encrypt(raw)
        } catch {
          return NextResponse.json(
            { error: 'No se pudo encriptar el token (revisa ENCRYPTION_KEY).' },
            { status: 500 },
          )
        }
      } else {
        patch.resend_api_key = null
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nada que guardar.' }, { status: 400 })
    }

    const { error } = await db
      .from('whatsapp_config')
      .update(patch)
      .eq('id', existing.id)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
