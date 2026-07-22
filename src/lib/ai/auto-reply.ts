import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import { extractImageMarkers } from './product-images'
import { extractDealMarkers, applyDealUpdates } from './deal-updates'
import { notifyHumanNeeded } from '@/lib/notify/human-alert'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

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

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt =
      buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
      }) + orderContext

    // One retry on transient provider failures (overloaded / network
    // blip): a single hiccup must not leave the customer unanswered.
    let reply
    try {
      reply = await generateReply({ config, systemPrompt, messages })
    } catch (genErr) {
      console.error('[ai auto-reply] generateReply failed, retrying once:', genErr)
      await new Promise((r) => setTimeout(r, 2000))
      reply = await generateReply({ config, systemPrompt, messages })
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
    void applyDealUpdates(db, { accountId, contactId }, deal.updates)

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: cleanText || deal.cleanText || text,
      aiGenerated: true,
    })

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
