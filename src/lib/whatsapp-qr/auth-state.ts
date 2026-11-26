// Credenciales de la sesión de WhatsApp Web guardadas (cifradas) en
// Supabase: así un reinicio o un deploy reconecta sin volver a escanear.
import type { AuthenticationState, SignalDataTypeMap } from 'baileys'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

const LOTE = 100

function enLotes<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += LOTE) out.push(items.slice(i, i + LOTE))
  return out
}

export async function borrarCredenciales(accountId: string): Promise<void> {
  const { error } = await supabaseAdmin().from('wa_qr_auth').delete().eq('account_id', accountId)
  if (error) throw new Error(`wa_qr_auth delete: ${error.message}`)
}

export async function usarAuthEnBase(accountId: string): Promise<{
  state: AuthenticationState
  saveCreds: () => Promise<void>
}> {
  const { BufferJSON, initAuthCreds, proto } = await import('baileys')
  const db = supabaseAdmin()

  // Si la lectura falla hay que tirar el error: devolver "vacío" crearía
  // credenciales nuevas y pisaría la sesión buena.
  const leer = async (keys: string[]): Promise<Map<string, unknown>> => {
    const out = new Map<string, unknown>()
    for (const lote of enLotes(keys)) {
      const { data, error } = await db
        .from('wa_qr_auth')
        .select('key, value')
        .eq('account_id', accountId)
        .in('key', lote)
      if (error) throw new Error(`wa_qr_auth read: ${error.message}`)
      for (const row of data ?? []) {
        out.set(row.key, JSON.parse(decrypt(row.value), BufferJSON.reviver))
      }
    }
    return out
  }

  const escribir = async (entradas: [string, unknown][]) => {
    const guardar = entradas
      .filter(([, v]) => v)
      .map(([key, v]) => ({
        account_id: accountId,
        key,
        value: encrypt(JSON.stringify(v, BufferJSON.replacer)),
      }))
    const borrar = entradas.filter(([, v]) => !v).map(([k]) => k)
    for (const lote of enLotes(guardar)) {
      const { error } = await db.from('wa_qr_auth').upsert(lote, { onConflict: 'account_id,key' })
      if (error) throw new Error(`wa_qr_auth write: ${error.message}`)
    }
    for (const lote of enLotes(borrar)) {
      const { error } = await db
        .from('wa_qr_auth')
        .delete()
        .eq('account_id', accountId)
        .in('key', lote)
      if (error) throw new Error(`wa_qr_auth delete: ${error.message}`)
    }
  }

  const creds =
    ((await leer(['creds'])).get('creds') as AuthenticationState['creds'] | undefined) ??
    initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const filas = await leer(ids.map((id) => `${type}:${id}`))
          const out: { [id: string]: SignalDataTypeMap[T] } = {}
          for (const id of ids) {
            let v = filas.get(`${type}:${id}`)
            if (!v) continue
            if (type === 'app-state-sync-key') {
              v = proto.Message.AppStateSyncKeyData.fromObject(v as Record<string, unknown>)
            }
            out[id] = v as SignalDataTypeMap[T]
          }
          return out
        },
        set: async (data) => {
          const entradas: [string, unknown][] = []
          for (const [type, porId] of Object.entries(data)) {
            for (const [id, v] of Object.entries(porId ?? {})) entradas.push([`${type}:${id}`, v])
          }
          await escribir(entradas)
        },
      },
    },
    saveCreds: () => escribir([['creds', creds]]),
  }
}
