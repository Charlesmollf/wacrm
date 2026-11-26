import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { qrHabilitado } from '@/lib/whatsapp-qr/config'
import { supervisar } from '@/lib/whatsapp-qr/manager'

/** Keepalive desde pg_cron: despierta el proceso y mantiene la conexión. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  const { data } = await supabaseAdmin().from('app_cron_auth').select('token').eq('id', 1).maybeSingle()
  const a = Buffer.from(token)
  const b = Buffer.from(String(data?.token ?? ''))
  if (!a.length || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!qrHabilitado()) return NextResponse.json({ ok: true, enabled: false })
  await supervisar()
  return NextResponse.json({ ok: true, enabled: true })
}
