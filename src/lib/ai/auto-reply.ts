import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildCustomerFile } from './customer-file'
import { buildConversationContext } from './context'
import { retrieveAllKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import { extractImageMarkers } from './product-images'
import { extractDealMarkers, applyDealUpdates } from './deal-updates'
import { notifyHumanNeeded } from '@/lib/notify/human-alert'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { enforceTotales, enforceAccesorios } from './enforce-totales'
import { desgloseDelPedido } from './carrito'
import { revisarSalida, mensajeDeRespaldo, formatoWhatsApp } from './portero'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    // Debounce rapid-fire bursts: wait a few seconds, and if the customer
    // sent another message meanwhile, bail — that later message's handler
    // replies with the full context. Stops the duplicate / partial replies
    // we got when someone types several lines in a row.
    const debounceStart = new Date().toISOString()
    await new Promise((r) => setTimeout(r, 5000))
    const { data: newerMsgs } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .gt('created_at', debounceStart)
      .limit(1)
    if (newerMsgs && newerMsgs.length > 0) return

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // FICHA DEL CLIENTE: que datos ya tenemos, cuales faltan, y la
    // regla de estilo que impide repetir el resumen en cada mensaje.
    const { context: customerContext } = await buildCustomerFile(
      db,
      accountId,
      contactId,
    )

    // Ground the model in this contact's CURRENT order (the CRM is the
    // source of truth) so a question days later ("¿cuándo llega?"), a
    // late payment, or a re-sent receipt is related to the EXISTING
    // order instead of being misread as a new purchase — the root cause
    // of the duplicated-order incidents (payment arriving 2-3 days
    // after the order, delivery questions re-confirming the pedido).
    let orderContext = ''
    try {
      const { data: lastDeal } = await db
        .from('deals')
        .select('value, payment_status, payment_method, combo_history, notes, created_at')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (lastDeal && (lastDeal.value || lastDeal.payment_status)) {
        const lastCombo =
          (lastDeal.combo_history || '').trim().split('\n').pop() || '—'
        orderContext =
          `\n\nPEDIDO ACTUAL DE ESTE CLIENTE SEGUN EL CRM (fuente de verdad, puede ser de dias atras): ` +
          `producto: ${lastCombo}; total: Q${lastDeal.value ?? 0}; ` +
          `estado de pago: ${lastDeal.payment_status ?? 'sin registrar'}; ` +
          `forma de pago: ${lastDeal.payment_method ?? '—'}; ` +
          `registrado el: ${String(lastDeal.created_at).slice(0, 10)}` +
          (lastDeal.notes ? `; nota: ${lastDeal.notes}` : '') +
          `. REGLA CRITICA: si el cliente pregunta por la entrega, el estado, o manda un pago/comprobante ` +
          `que corresponde a ESTE pedido (aunque hayan pasado dias), relacionalo con el pedido EXISTENTE: ` +
          `NO lo confirmes de nuevo, NO emitas total, y si el estado ya es "Por confirmar" o "Pagado" NO ` +
          `pongas estado_pago otra vez. Trata la conversacion como VENTA NUEVA solo si el cliente pide ` +
          `explicitamente comprar OTRA vez. Si tienes duda, pregunta con comunicacion asertiva, por ejemplo: ` +
          `"¿Me confirma si se refiere a su pedido anterior o desea hacer un pedido nuevo?"`
      }
    } catch {
      // best-effort — a failed lookup must never block the reply
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // PREFIJO ESTABLE (se cachea): persona + reglas + catalogo + la base
    // de conocimiento COMPLETA. Identico en toda llamada, para todos los
    // clientes. Antes aqui iba una busqueda por palabras clave que
    // devolvia fragmentos distintos en cada mensaje y rompia el cache.
    const knowledge = await retrieveAllKnowledge(db, accountId)
    const stableSystem = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    // VOLATIL (nunca se cachea): va DESPUES del prefijo, siempre.
    const systemPrompt = stableSystem + customerContext + orderContext

    // One retry on transient provider failures (overloaded / network
    // blip): a single hiccup must not leave the customer unanswered.
    let reply
    try {
      reply = await generateReply({
        config,
        systemPrompt,
        cachePrefix: stableSystem,
        messages,
      })
    } catch (genErr) {
      console.error('[ai auto-reply] generateReply failed, retrying once:', genErr)
      await new Promise((r) => setTimeout(r, 2000))
      reply = await generateReply({
        config,
        systemPrompt,
        cachePrefix: stableSystem,
        messages,
      })
    }
    const { text, handoff, usage } = reply

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)

      // Email the owner the moment the AI hands the thread to a human —
      // the exact instant the conversation becomes "assigned" — so they
      // know to jump in even before the customer writes again. The
      // webhook's per-burst alert covers every SUBSEQUENT message; this
      // covers the handoff itself. Fire-and-forget, best-effort.
      void notifyHumanNeeded(db, {
        accountId,
        conversationId,
        contactId,
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    // Pull structured lead data ([[SET:...]]) then product-photo markers
    // ([[IMG:...]]) out of the reply. Both are stripped before sending so
    // the customer never sees them; the data is written to the deal card
    // best-effort (never blocks or fails the send).
    const deal = extractDealMarkers(text)
    const { cleanText, images } = extractImageMarkers(deal.cleanText)
    // Se ESPERA a que el pedido quede guardado: el total que va a revisar el
    // portero se calcula de lo que quedo en la ficha, no de lo que el modelo
    // dice haber entendido.
    await applyDealUpdates(db, { accountId, contactId }, deal.updates)

    // Texto final ya SIN marcas internas. Si el modelo respondió solo con
    // la marca de datos ([[SET: ...]]), el texto queda vacío: en ese caso
    // NO se envía nada. Antes el respaldo mandaba el texto crudo y el
    // cliente llegaba a ver la marca interna en su chat.
    const finalText = enforceSuma(
      enforceAccesorios(
        enforceTotales(
          enforceBankAccount(stripInternalMarkers(cleanText || deal.cleanText || '')),
        ),
      ),
    )
    // ---- EL PORTERO -------------------------------------------------------
    // El precio deja de salir de lo que escriba el modelo. Se calcula con la
    // caja registradora a partir del pedido guardado, y si el mensaje afirma
    // otro numero no se manda: sale el desglose armado por codigo.
    //
    // No se reintenta con el modelo, porque volveria a inventar. Y si el
    // pedido no se puede calcular, el portero solo cuida la cuenta bancaria y
    // deja pasar el resto: una consulta de precios no se bloquea.
    let textoAEnviar = finalText
    if (finalText) {
      try {
        const { data: filaPedido } = await db
          .from('deals')
          .select('carrito, combo_history')
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const desglose = desgloseDelPedido(filaPedido)
        const veredicto = revisarSalida(finalText, desglose)
        if (!veredicto.ok) {
          console.warn(
            `[portero] mensaje frenado (${veredicto.motivo}). Sale el desglose del codigo.`,
          )
          textoAEnviar = desglose ? mensajeDeRespaldo(desglose, finalText) : finalText
        }
      } catch (err) {
        // Un fallo del portero jamas deja al cliente sin respuesta.
        console.error('[portero] no se pudo revisar la salida:', err)
      }
    }

    // Ultimo paso antes de salir: el formato que WhatsApp entiende.
    // Va aqui, despues del portero, para que tambien limpie el mensaje de
    // respaldo y no quede un asterisco pegado a nada.
    textoAEnviar = formatoWhatsApp(textoAEnviar)

    if (textoAEnviar) {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: textoAEnviar,
        aiGenerated: true,
      })
    } else {
      console.warn(
        '[ai auto-reply] la respuesta era solo una marca interna; no se envía nada al cliente.',
      )
    }

    for (const img of images) {
      try {
        await engineSendMedia({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          kind: 'image',
          link: img.url,
        })
      } catch (mediaErr) {
        console.error('[ai auto-reply] product image send failed:', mediaErr)
      }
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/**
 * Red de seguridad: quita cualquier marca interna que se haya escapado
 * ([[SET: ...]], [[IMG: ...]], [[HANDOFF]]). El cliente jamás debe ver
 * estas marcas — son instrucciones internas del sistema.
 */
function stripInternalMarkers(text: string): string {
  return text
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Unica cuenta bancaria real del negocio. */
const CUENTA_OFICIAL = '30-3093873-2'

/**
 * Candado anti-error de aritmetica.
 *
 * Haiku escribio "Q400 + Q45 de envio = Q390 total". El 390 no salio de
 * sumar: salio de los EJEMPLOS de este mismo prompt (Mitico Coban Q345 ->
 * 390). El modelo copio el ejemplo que mas se le parecia. Lo cacho el
 * cliente, no nosotros.
 *
 * Ensenar la suma con ejemplos invita justo a ese error, y ningun modelo
 * esta libre de el. Asi que aqui no se le pide al modelo que sume bien: se
 * VERIFICA. Si el mensaje dice "a + b = c" y c no es a+b, se corrige c
 * antes de enviarlo.
 *
 * Solo toca el resultado de una suma explicita. Un precio suelto, un
 * telefono o una fecha nunca entran: no tienen la forma "n + n = n".
 */
export function enforceSuma(text: string): string {
  const SUMA =
    /((?:Q\s*)?\d{1,6}(?:[.,]\d{1,2})?(?:\s*\+\s*(?:Q\s*)?\d{1,6}(?:[.,]\d{1,2})?)+)([^=\n]{0,30}?)(=\s*Q?\s*)(\d{1,6}(?:[.,]\d{1,2})?)/g

  return text.replace(
    SUMA,
    (completo, sumandos: string, medio: string, igual: string, dicho: string) => {
      const aNumero = (t: string) =>
        Number(t.replace(/[^\d.,]/g, '').replace(',', '.'))
      const partes = (sumandos.match(/\d{1,6}(?:[.,]\d{1,2})?/g) ?? []).map(aNumero)
      if (partes.length < 2 || partes.some((n) => !Number.isFinite(n))) return completo

      const esperado = partes.reduce((a, b) => a + b, 0)
      const anunciado = aNumero(dicho)
      if (!Number.isFinite(anunciado) || Math.abs(anunciado - esperado) < 0.01) {
        return completo
      }

      const correcto = Number.isInteger(esperado)
        ? String(esperado)
        : esperado.toFixed(2)
      console.warn(
        `[ai] suma mal hecha, corregida antes de enviar: "${completo.trim()}" -> ${correcto}`,
      )
      return `${sumandos}${medio}${igual}${correcto}`
    },
  )
}

/**
 * Candado anti-alucinación de datos bancarios.
 *
 * El modelo llegó a inventar números de cuenta ("3304629171", "3502469811")
 * al responder por transferencia — un cliente podría mandar su dinero a una
 * cuenta inexistente. Antes de enviar cualquier respuesta que hable de
 * transferencia/cuenta, se reemplaza cualquier secuencia que parezca un
 * número de cuenta por la cuenta oficial. Es una red de seguridad: la regla
 * también está en el prompt, pero esto garantiza que NUNCA salga otro número.
 */
function enforceBankAccount(text: string): string {
  // Solo se toca un numero cuando la etiqueta dice CUENTA de verdad.
  //
  // Antes la lista incluia "numero" y "no", sin limite de palabra. El "no"
  // final de "Telefo-no" matcheaba, y el candado reemplazaba el telefono del
  // cliente por nuestra cuenta bancaria. Salio asi en el resumen de Marlenne
  // y en el de Davies Guit: "Telefono: 30-3093873-2". Con ese dato la guia de
  // Cargo Expreso queda sin forma de llamar al cliente.
  const ETIQUETA_CUENTA =
    /(\b(?:cuenta|cta\.?|monetaria|bam)\b[^\d\n]{0,24}?)(\d[\d\s-]{6,24}\d)/gi
  // Si en el mismo tramo se habla de telefono, guia o NIT, ese numero no es
  // una cuenta aunque la palabra "cuenta" ande cerca.
  const NO_ES_CUENTA =
    /\b(tel[eé]fono|tel\.?|celular|whatsapp|gu[ií]a|nit|zona)\b/i
  return text.replace(ETIQUETA_CUENTA, (full, etiqueta: string, numero: string) => {
    if (NO_ES_CUENTA.test(etiqueta)) return full
    const soloDigitos = numero.replace(/\D/g, '')
    if (soloDigitos === CUENTA_OFICIAL.replace(/\D/g, '')) return full
    return `${etiqueta}${CUENTA_OFICIAL}`
  })
}
