import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Credenciales del webhook de la hoja de pedidos (Apps Script).
 *
 * POR QUE EXISTE ESTE ARCHIVO
 *
 * `sheets_webhook_token` se guardaba EN CLARO, y la politica
 * `whatsapp_config_select` deja leer esa tabla a cualquier miembro de
 * la cuenta — tambien al rol mas bajo, `agent`. O sea: cualquier
 * agente podia sacar del navegador el token que escribe en la hoja de
 * pedidos de la tostaduria. Los otros cuatro secretos de la tabla
 * (access_token, verify_token, capi_access_token, resend_api_key) ya
 * viajaban cifrados; este era el unico que no.
 *
 * Ahora se cifra con el mismo AES-256-GCM que el resto
 * (`lib/whatsapp/encryption`).
 *
 * TOLERANCIA AL VALOR VIEJO
 *
 * El valor que ya esta en la base sigue en texto plano hasta que se
 * migre. Si este codigo exigiera formato cifrado, entre el deploy y la
 * migracion se caerian las guias y el alta de pedidos. Por eso se
 * aceptan los dos formatos: se mira la FORMA del valor y se descifra
 * solo lo que de verdad esta cifrado.
 *
 * Cuando la migracion este hecha y confirmada, se puede borrar la rama
 * de texto plano y exigir cifrado siempre.
 */

export interface SheetsWebhook {
  url: string
  /** Token ya en claro, listo para mandarle al Apps Script. */
  token: string
}

/**
 * Un valor cifrado por `encrypt()` es `iv:ct` (CBC viejo) o
 * `iv:ct:tag` (GCM actual), todo en hexadecimal. El token en claro es
 * un UUID: no lleva `:` y trae guiones. La forma alcanza para
 * distinguirlos sin arriesgar un decrypt a ciegas.
 */
export function pareceCifrado(valor: string): boolean {
  return /^[0-9a-f]{24,32}:[0-9a-f]+(:[0-9a-f]{32})?$/i.test(valor)
}

/**
 * Devuelve el token en claro, o null si esta cifrado y no se pudo
 * abrir. Null NO se trata como "no configurado" a la ligera: quien
 * llama corta y avisa, en vez de mandarle basura al Apps Script y
 * comerse un "token invalido" sin explicacion.
 */
export function abrirToken(guardado: string): string | null {
  if (!pareceCifrado(guardado)) return guardado
  try {
    return decrypt(guardado)
  } catch (err) {
    console.error('[sheets] no se pudo descifrar sheets_webhook_token:', err)
    return null
  }
}

/**
 * Lee la URL y el token del webhook de la hoja para una cuenta.
 * Devuelve null cuando la hoja no esta configurada o el token no se
 * pudo abrir.
 */
export async function loadSheetsWebhook(
  db: SupabaseClient,
  accountId: string,
): Promise<SheetsWebhook | null> {
  const { data: cfg } = await db
    .from('whatsapp_config')
    .select('sheets_webhook_url, sheets_webhook_token')
    .eq('account_id', accountId)
    .maybeSingle()

  const url = cfg?.sheets_webhook_url as string | undefined
  const guardado = cfg?.sheets_webhook_token as string | undefined
  if (!url || !guardado) return null

  const token = abrirToken(guardado)
  if (!token) return null

  return { url, token }
}
