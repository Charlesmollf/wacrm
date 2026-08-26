import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * FICHA DEL CLIENTE — el bloque de contexto que le dice al modelo QUE
 * datos ya tenemos y CUALES faltan.
 *
 * Nace de dos problemas reales:
 *
 *  1. El bot pedia de cero datos que ya estaban en el CRM (la cartera
 *     importada de Kommo trae correo, direccion, molienda y hasta el
 *     ultimo combo). Al cliente viejo hay que CONFIRMARLE sus datos, no
 *     interrogarlo.
 *
 *  2. El bot repetia el resumen completo del pedido cada vez que el
 *     cliente soltaba un dato. El cliente manda la direccion y recibe de
 *     vuelta producto + direccion; dice "molido" y recibe otra vez
 *     producto + direccion + molido + precio + envio. Ningun humano
 *     vende asi, y cada repeticion cuesta tokens que ademas se quedan en
 *     el historial y encarecen TODAS las respuestas siguientes.
 *
 * La solucion es darle al modelo la ficha ya resuelta —lo que hay y lo
 * que falta— para que pueda contestar en una linea pidiendo unicamente
 * el hueco que queda, y dejar el resumen para el cierre.
 */

/** Datos indispensables para poder cerrar un pedido. */
const REQUERIDOS = ['nombre', 'correo', 'direccion', 'grano o molido', 'producto'] as const

export interface CustomerFileResult {
  /** Bloque listo para concatenar al system prompt ('' si no hay nada). */
  context: string
  /** Campos que aun faltan (vacio = ya se puede cerrar). */
  missing: string[]
}

export async function buildCustomerFile(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<CustomerFileResult> {
  const vacio: CustomerFileResult = { context: '', missing: [] }
  try {
    const [{ data: cont }, { data: notes }, { data: deal }] = await Promise.all([
      db.from('contacts').select('name, phone, email, wa_profile_name').eq('id', contactId).maybeSingle(),
      db
        // OJO: la columna es `note_text`, NO `content`. Estuvo mal escrita
        // y por eso el historial de Kommo nunca llegaba al modelo.
        .from('contact_notes')
        .select('note_text')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(2),
      db
        .from('deals')
        .select('address, grind, nit, payment_method, payment_status, combo_history, value')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    const ultimoCombo =
      String(deal?.combo_history ?? '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop() ?? ''

    const tiene: Record<string, string> = {}
    // El nombre del perfil de WhatsApp NO cuenta como nombre confirmado:
    // la mitad de las veces es un apodo y con ese nombre se rotula la guia
    // de Cargo Expreso. Se muestra igual, pero sigue contando como faltante
    // para que el bot lo confirme antes de cerrar.
    const nombreGuardado = String(cont?.name ?? '').trim()
    const perfilWa = String(cont?.wa_profile_name ?? '').trim()
    const soloDigitos = (s: string) => s.replace(/\D/g, '')
    const nombreConfirmado =
      nombreGuardado.length > 1 &&
      nombreGuardado.toLowerCase() !== perfilWa.toLowerCase() &&
      soloDigitos(nombreGuardado) !== soloDigitos(String(cont?.phone ?? ''))
    if (nombreConfirmado) tiene['nombre'] = nombreGuardado
    else if (nombreGuardado)
      tiene['nombre (SIN CONFIRMAR, es el perfil de WhatsApp)'] = nombreGuardado
    if (cont?.phone) tiene['telefono'] = String(cont.phone)
    if (cont?.email) tiene['correo'] = String(cont.email)
    if (deal?.address) tiene['direccion'] = String(deal.address)
    if (deal?.grind) tiene['grano o molido'] = String(deal.grind)
    if (ultimoCombo) tiene['producto'] = ultimoCombo
    if (deal?.payment_method) tiene['forma de pago'] = String(deal.payment_method)
    if (deal?.nit) tiene['NIT'] = String(deal.nit)

    const historial = (notes ?? [])
      .map((n) => String((n as { note_text?: string }).note_text || '').trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 400)

    // Estado del pedido en curso. Sin esto el bot no sabe que ese pedido YA
    // se mando a confirmar, y trata cada dato que llega despues (una direccion
    // confirmada, un cambio de molienda) como si abriera un pedido nuevo.
    // Le paso a Luis Lopez Bonilla el 25-08: mando el comprobante a las 13:30,
    // confirmo la direccion a las 15:07, y salio confirmacion dos veces.
    const estadoPago = String(deal?.payment_status ?? '').trim()
    const yaEnCola = /por confirmar/i.test(estadoPago)
    const yaPagado = /pagad/i.test(estadoPago)
    const totalActual = deal?.value ? `Q${String(deal.value).replace(/\.00$/, '')}` : ''

    const missing = REQUERIDOS.filter((c) => !tiene[c])
    if (Object.keys(tiene).length === 0 && !historial) return vacio

    const lineas = Object.entries(tiene).map(([k, v]) => `- ${k}: ${v}`)
    if (historial) lineas.push(`- historial: ${historial}`)

    const context =
      `\n\n=== FICHA DE ESTE CLIENTE (ya la tenemos guardada) ===\n` +
      lineas.join('\n') +
      `\n` +
      (missing.length > 0
        ? `FALTA UNICAMENTE: ${missing.join(', ')}.\n`
        : `NO FALTA NINGUN DATO: ya se puede cerrar el pedido.\n`) +
      (yaEnCola
        ? `\n=== ESTE PEDIDO YA ESTA EN LA COLA DE CONFIRMACION ===\n` +
          `El pedido de ${totalActual || 'este cliente'} ya se mando a confirmar. Por lo tanto:\n` +
          `- Cualquier dato que mande ahora (direccion, molienda, NIT, un "si") CORRIGE ese mismo\n` +
          `  pedido. NO es un pedido nuevo. NO lo vuelvas a confirmar ni repitas el resumen completo.\n` +
          `- Responde en UNA linea confirmando el cambio, nada mas.\n` +
          `- Solo si el cliente pide MAS cafe ademas de lo ya confirmado, preguntale claro:\n` +
          `  "¿Se lo agrego al pedido que ya tengo o es uno aparte?" y ESPERA su respuesta\n` +
          `  antes de tocar el total.\n`
        : yaPagado
          ? `\n=== EL PEDIDO ANTERIOR YA ESTA PAGADO ===\n` +
            `Si pide cafe otra vez es un pedido NUEVO y arranca de cero.\n`
          : '') +
      `\n=== COMO CONTESTAR (regla de estilo, es obligatoria) ===\n` +
      `1. Cada dato que el cliente manda se guarda SOLO en el CRM. NUNCA se lo repitas de vuelta.\n` +
      `2. Contesta en UNA o DOS lineas: reconoce brevemente y pide UNICAMENTE lo que falta de la lista de arriba.\n` +
      `   Ejemplos del tono correcto: "Anotado 😊 ¿Lo prefiere en grano o molido?" / "Gracias. Solo me faltaria su correo."\n` +
      `3. PROHIBIDO mandar el resumen del pedido en cada mensaje. Los humanos no hacen eso.\n` +
      `4. El resumen COMPLETO (producto, molienda, direccion, total con envio) se manda UNA SOLA VEZ:\n` +
      `   cuando ya no falte ningun dato, justo antes de preguntar como desea pagar.\n` +
      `5. Si despues de eso el cliente cambia o agrega algo, confirma SOLO el cambio y el total nuevo, en una linea.\n` +
      `6. Un dato que ya aparece arriba NO se pide: se CONFIRMA en una linea\n` +
      `   (ej. "¿Se lo enviamos a la misma direccion de la vez pasada?" / "¿Molido como siempre?").\n` +
      `7. Si el cliente da un dato distinto al que teniamos (direccion, forma de pago, estado), el NUEVO manda: usalo y guardalo.\n` +
      `8. El NOMBRE es obligatorio para cerrar. Si arriba dice "SIN CONFIRMAR", ese nombre viene del perfil de WhatsApp\n` +
      `   y NO sirve para rotular la guia de envio: confirmalo en una linea ("¿A nombre de quien preparo el pedido?")\n` +
      `   ANTES de dar el total. Sin nombre confirmado no mandes el resumen ni cierres el pedido.\n`

    return { context, missing: [...missing] }
  } catch {
    // best-effort: una ficha que falla jamas debe dejar al cliente sin respuesta
    return vacio
  }
}
