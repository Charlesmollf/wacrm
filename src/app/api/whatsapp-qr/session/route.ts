import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { qrHabilitado } from '@/lib/whatsapp-qr/config'
import { desvincular, supervisar } from '@/lib/whatsapp-qr/manager'

/** ¿La cuenta ya usa Cloud API? Entonces el QR no se le ofrece. */
async function usaCloudApi(accountId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .limit(1)
  if (error) throw new Error(error.message)
  return !!data?.length
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const apagado = { available: false, active: false }
    if (!qrHabilitado() || (await usaCloudApi(ctx.accountId))) return NextResponse.json(apagado)

    const { data, error } = await supabaseAdmin()
      .from('wa_qr_session')
      .select('enabled, status, qr, phone, last_error')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (data?.enabled) await supervisar()

    // El QR da acceso total al WhatsApp: solo lo ve un administrador.
    const admin = hasMinRole(ctx.role, 'admin')
    return NextResponse.json({
      available: true,
      active: !!data,
      canManage: admin,
      status: data?.status ?? 'disconnected',
      phone: data?.phone ?? null,
      lastError: admin ? (data?.last_error ?? null) : null,
      qr: admin && data?.qr ? await QRCode.toDataURL(data.qr, { width: 288, margin: 2 }) : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Conectar: crea o reactiva la sesión; el QR aparece en el GET. */
export async function POST() {
  try {
    const ctx = await requireRole('admin')
    if (!qrHabilitado()) {
      return NextResponse.json({ error: 'WhatsApp por QR está apagado' }, { status: 403 })
    }
    if (await usaCloudApi(ctx.accountId)) {
      return NextResponse.json({ error: 'Esta cuenta ya usa la API oficial' }, { status: 409 })
    }
    const { error } = await supabaseAdmin()
      .from('wa_qr_session')
      .upsert(
        {
          account_id: ctx.accountId,
          user_id: ctx.userId,
          enabled: true,
          status: 'starting',
          qr: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' },
      )
    if (error) throw new Error(error.message)
    await supervisar()
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin')
    await desvincular(ctx.accountId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
