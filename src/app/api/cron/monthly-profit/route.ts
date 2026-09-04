import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { recalcularGananciaMensual } from '@/lib/finance/monthly-profit'

export const maxDuration = 60

/**
 * GET /api/cron/monthly-profit?token=<uuid>
 *
 * Recalcula `monthly_profit` (ventas, costo estimado y ganancia por mes)
 * a partir de los deals Pagados y lo guarda para que el dashboard lo lea
 * directo, sin recalcular en el navegador. Mismo token que
 * /api/cron/tick (`app_cron_auth`) — un solo secreto para todos los
 * crons de este CRM.
 *
 * Pensado para correr una vez al mes (ver `wacrm_tick` en pg_cron para
 * el patron de como agendarlo); tambien se puede llamar a mano.
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

  const resultado = await recalcularGananciaMensual(admin)
  if (!resultado.ok) {
    return NextResponse.json({ ok: false, error: resultado.error }, { status: 500 })
  }
  return NextResponse.json({ ok: true, meses: resultado.meses })
}
