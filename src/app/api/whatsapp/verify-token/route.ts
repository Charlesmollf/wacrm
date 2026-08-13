import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/whatsapp/verify-token  (admin+)
 *
 * TEMPORAL — borrar cuando el webhook quede verificado.
 *
 * Devuelve el token de verificacion del webhook en claro. Se necesita
 * para volver a validar el webhook en Meta despues del cambio de
 * dominio a crm.kaffeejager.shop: Meta obliga a reescribir el token
 * cada vez que se edita la URL de devolucion de llamada, y el token
 * vive encriptado en la base con ENCRYPTION_KEY.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')

    const { data, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('verify_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json(
        { error: 'No se pudo leer la configuracion' },
        { status: 500 },
      )
    }
    if (!data?.verify_token) {
      return NextResponse.json(
        { error: 'No hay token de verificacion guardado' },
        { status: 404 },
      )
    }

    return NextResponse.json({ verify_token: decrypt(data.verify_token) })
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status?: number }).status ?? 500
        : 500
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error inesperado' },
      { status },
    )
  }
}
