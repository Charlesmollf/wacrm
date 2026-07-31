import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import { extractImageMarkers } from './product-images'
import { extractDealMarkers, applyDealUpdates, DEAL_EXTRACTION_INSTRUCTIONS } from './deal-updates'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { buildConversationContext } from './context'
import { dispatchInboundToAiReply } from './auto-reply'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

// Anthropic vision accepts these media types. WhatsApp photos are almost
// always JPEG; we coerce anything unexpected to jpeg so the API call
// still succeeds rather than 400-ing on an odd content-type.
const VISION_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

interface DispatchImageArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  /** Meta media id of the inbound image (message.image.id). */
  mediaId: string
  /** Decrypted WhatsApp access token — used to fetch the media bytes. */
  accessToken: string
  /** Optional caption the customer sent with the image. */
  caption?: string
}

/**
 * AI auto-reply for an inbound IMAGE message (photo / screenshot).
 *
 * Mirrors dispatchInboundToAiReply's eligibility gates, but instead of a
 * text transcript it sends the actual image to a vision-capable model so
 * the agent can identify the product in the photo and respond. Kept in a
 * separate module so the (working) text path is untouched.
 *
 * Owns its try/catch and NEVER throws — a failing vision call must not
 * affect the webhook's 200 to Meta.
 */
export async function dispatchInboundImageToAiReply(
  args: DispatchImageArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    mediaId,
    accessToken,
    caption,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return
    // Vision is implemented for Anthropic (the account's provider). For
    // any other provider we silently skip — the image still sits in the
    // inbox for a human.
    if (config.provider !== 'anthropic') return

    // Stand down if any per-message automation could also answer (avoid
    // double-texting) — mirrors the text auto-reply's guard.
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv) return
    if (conv.assigned_agent_id) return
    if (conv.ai_autoreply_disabled) return
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    // Fetch the image bytes from Meta and base64-encode for the vision API.
    let base64: string
    let mediaType: string
    try {
      const { url, mimeType } = await getMediaUrl({ mediaId, accessToken })
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: url,
        accessToken,
      })
      base64 = buffer.toString('base64')
      const mt = (contentType || mimeType || '').toLowerCase().split(';')[0]
      mediaType = VISION_MEDIA_TYPES.has(mt) ? mt : 'image/jpeg'
    } catch (err) {
      // Vision path broke — fall back to the plain-text auto-reply so
      // the customer still gets an answer instead of silence.
      console.error('[ai image-reply] media fetch failed, falling back to text reply:', err)
      await dispatchInboundToAiReply({ accountId, conversationId, contactId, configOwnerUserId })
      return
    }

    // MEMORIA: el camino de visión respondía SOLO mirando la foto, sin el
    // historial ni la ficha del cliente. Por eso, ante una imagen
    // ambigua (un sticker, un meme, un pulgar arriba), saludaba como si
    // fuera la primera vez y reiniciaba la venta. Ahora carga lo mismo
    // que el camino de texto: la conversación previa y el pedido vigente.
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
          `\n\nPEDIDO ACTUAL DE ESTE CLIENTE SEGUN EL CRM: producto: ${lastCombo}; ` +
          `total: Q${lastDeal.value ?? 0}; estado de pago: ${lastDeal.payment_status ?? 'sin registrar'}; ` +
          `forma de pago: ${lastDeal.payment_method ?? '—'}` +
          (lastDeal.notes ? `; nota: ${lastDeal.notes}` : '') +
          `. NUNCA saludes como si fuera la primera vez ni reinicies la venta: continua la conversacion donde iba.`
      }
    } catch {
      // best-effort
    }

    const system =
      `${config.systemPrompt}${orderContext}\n\n` +
      `[INSTRUCCIÓN ESPECIAL] El cliente acaba de enviar una IMAGEN (una foto o ` +
      `captura de pantalla). Analízala con cuidado. Si muestra un café o producto ` +
      `de Kaffeejager, identifícalo por la etiqueta, el color de la bolsa o el ` +
      `nombre visible, y responde como asesor: menciona el producto, su precio ` +
      `según tu base de conocimiento, y pregunta si lo prefiere en grano o molido. ` +
      `Si es un producto que no manejas, ofrece el más parecido de tu catálogo. ` +
      `Si la imagen no muestra un producto claro, pregunta amablemente en qué le ` +
      `puedes ayudar. Responde en español, breve y cálido, sin inventar precios.\n\n` +
      DEAL_EXTRACTION_INSTRUCTIONS

    const userText = caption
      ? `El cliente envió esta imagen y escribió: "${caption}"`
      : 'El cliente envió esta imagen.'

    // Historial previo (mismo que usa el camino de texto), normalizado a
    // la forma que exige Anthropic: empieza en `user` y sin dos turnos
    // seguidos del mismo rol. Se recortan los últimos 30 para acotar el
    // costo de la llamada con imagen.
    type VisionMsg = { role: 'user' | 'assistant'; content: unknown }
    const priorMsgs: VisionMsg[] = []
    try {
      const history = await buildConversationContext(db, conversationId)
      // La última entrada es el marcador de ESTA imagen; se descarta
      // porque la imagen real va como bloque aparte más abajo.
      const trimmed = history.slice(0, -1).slice(-30)
      for (const h of trimmed) {
        const role: 'user' | 'assistant' = h.role === 'user' ? 'user' : 'assistant'
        if (priorMsgs.length === 0 && role === 'assistant') continue
        const last = priorMsgs[priorMsgs.length - 1]
        if (last && last.role === role && typeof last.content === 'string') {
          last.content = `${last.content}\n${h.content}`
        } else {
          priorMsgs.push({ role, content: h.content })
        }
      }
      // El mensaje con la imagen es de rol `user`: si el último turno del
      // historial también lo es, se fusiona para no romper la alternancia.
      if (priorMsgs.length > 0 && priorMsgs[priorMsgs.length - 1].role === 'user') {
        priorMsgs.pop()
      }
    } catch (ctxErr) {
      console.error('[ai image-reply] no se pudo cargar el historial:', ctxErr)
    }

    let text: string
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          system,
          max_tokens: 1024,
          messages: [
            ...priorMsgs,
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64,
                  },
                },
                { type: 'text', text: userText },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) {
        console.error(
          '[ai image-reply] Anthropic error, falling back to text reply:',
          res.status,
          await res.text().catch(() => ''),
        )
        await dispatchInboundToAiReply({ accountId, conversationId, contactId, configOwnerUserId })
      return
      }
      const data = (await res.json().catch(() => null)) as {
        content?: { type?: string; text?: string }[]
      } | null
      text = (data?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim()
    } catch (err) {
      console.error('[ai image-reply] vision call failed, falling back to text reply:', err)
      await dispatchInboundToAiReply({ accountId, conversationId, contactId, configOwnerUserId })
      return
    }

    if (!text) {
      await dispatchInboundToAiReply({ accountId, conversationId, contactId, configOwnerUserId })
      return
    }

    // Atomically claim a reply slot (same cap guard the text path uses).
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      console.error('[ai image-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return

    // If the model recommended a product it can also show its photo —
    // pull any [[IMG: product]] markers, send the cleaned text, then the
    // matching image(s). Best-effort: a failed photo never loses the text.
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
        console.error('[ai image-reply] product image send failed:', mediaErr)
      }
    }
  } catch (err) {
    console.error('[ai image-reply] dispatch failed:', err)
  }
}
