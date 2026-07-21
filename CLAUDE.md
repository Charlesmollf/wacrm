# wacrm — Mapa de conocimiento (Kaffeejager Roastery)

CRM de WhatsApp (Next.js + Supabase) para Kaffeejager Roastery (café de especialidad, Guatemala).
Deploy: push a `main` → Hostinger auto-deploy (~2-3 min) en aqua-gaur-598822.hostingersite.com.
Supabase project: gxugzprqrbtdaligkzld. Migraciones se corren a mano en el SQL editor (no hay CLI CI).
CI de GitHub Actions está deshabilitado (solo workflow_dispatch) para no llenar el correo de fallos.

## Flujo principal (venta por WhatsApp)

1. `src/app/api/whatsapp/webhook/route.ts` — entrada de mensajes de Meta.
   - Captura `ctwa_clid` del referral (Click-to-WhatsApp ads) en la conversación.
   - Detecta comprobantes de pago (documento O texto con /pagalo|comprobante|voucher|boleta|deposito|recibo|transferenci|.pdf/) → `applyDealUpdates` con `payment_status: 'Por confirmar'`.
   - Stickers/imágenes van al camino de visión del bot.
2. `src/lib/ai/auto-reply.ts` — respuesta automática.
   - Debounce de 5 s: si el cliente manda varios mensajes seguidos, responde una sola vez con todo.
   - Inyecta el PEDIDO ACTUAL del CRM al prompt (producto, total, estado de pago) para que preguntas
     de entrega/pagos tardíos NO se conviertan en pedidos duplicados.
   - Ventana de contexto: 80 mensajes (`defaults.ts`), incluye placeholders de media del cliente
     (`context.ts`) para "ver" que envió un voucher hace días.
3. `src/lib/ai/deal-updates.ts` — parsea `[[SET: ...]]` del bot y escribe el deal.
   - Claves: forma_pago, estado_pago, molienda, combo, direccion, nit, notas (regalos), total.
   - NUNCA crea deals nuevos: actualiza el más reciente del contacto. `total` nuevo = venta nueva
     (reinicia ciclo de pago). Guardia: un pedido ya "Pagado" no vuelve a "Por confirmar" sin total nuevo.
   - Transición a 'Por confirmar' → email de alerta (`src/lib/notify/payment-alert.ts`, Resend) +
     sincroniza etiqueta "Pago: …" (`src/lib/crm/payment-tags.ts`).
4. `src/app/(dashboard)/payments/page.tsx` — cola "Confirmar pagos".
   - "Marcar como Pagado" llama a `POST /api/payments/confirm`.
5. `src/app/api/payments/confirm/route.ts` — marca Pagado + dispara Purchase a Meta CAPI + tag sync.

## Meta Ads / Conversions API

- `src/lib/meta/capi.ts` — Purchase server-side al dataset (pixel Shopify id 1066253287683027).
  - Con `ctwa_clid` → action_source business_messaging (atribución determinística CTWA).
  - Sin él → action_source website con matching avanzado (ph/em/fn/ln hasheados, fbc opcional).
- `POST /api/whatsapp/capi/backfill` (admin) — reinyecta compras de los últimos 7 días
  (Shopify contra-entrega no dispara pixel hasta estar PAID; ventas viejas del CRM).
- Config en Ajustes → WhatsApp: `capi_dataset_id`, `capi_access_token` (encriptado),
  `resend_api_key`, `alert_email` (kaffeejager@gmail.com). El dueño pega los tokens; nunca en código.
- Cuenta publicitaria: act_1418677364993352, business 2088994378032233.
  Campaña activa: "Ventas CRM/Claude - Whatsapi" (objetivo Ventas, optimiza Purchase).

## Base de datos — puntos no obvios

- `messages`: columnas `content_text`, `content_type` (NO `content`/`body`).
- `deals`: `combo_history` (líneas fechadas `[YYYY-MM-DD] producto`), `payment_status`
  (Pendiente | Por confirmar | Pagado), `sold_at`, `notes` (regalos: "Regalo para X, de parte de Y").
- Trigger `trg_sync_payment_tag` (AFTER UPDATE OF payment_status ON deals) mantiene la etiqueta
  "Pago: …" sincronizada aunque el estado se cambie a mano en el dropdown.
- `conversations`: `ctwa_clid`, `ctwa_captured_at`, `last_message_at` (orden del inbox).
- `broadcasts`: `scheduled_at`, `dispatch_status`, `send_payload` (migración 044). El cron de
  GitHub Actions es POCO fiable (corre cada horas, no cada 5 min) — envíos grandes se hacen en
  lotes de ~35 vía la API directa para no exceder timeouts.
- Prompt del bot: `ai_configs` id 76fc3b2b-106d-45ed-a072-c12fc7b17b2d (system_prompt).

## Lecciones aprendidas (no repetir)

- React: `router.replace()` puede ser no-op silencioso → usar `window.history.replaceState`.
- useCallback: revisar SIEMPRE el array de deps al agregar estado nuevo (bug del guardado de Ajustes).
- La lista del inbox se ordena en `conversation-list.tsx` (memo `filtered` re-sortea por
  `last_message_at` desc); el fetch inicial también ordena así.
- Resend con `onboarding@resend.dev` cae en spam → verificar dominio propio (pendiente).
- Shopify: pedidos contra entrega quedan PENDING y el pixel del navegador NO dispara Purchase;
  por eso existe el backfill server-side.
- Broadcasts: Meta acepta y luego capa frecuencia de marketing sin error visible; wacrm solo
  muestra delivered/read si existen filas en `broadcast_recipients` (los envíos directos no las crean).
- Cliente que pregunta "¿cuándo llega?" días después + reenvía comprobante = MISMO pedido.
  Nunca re-confirmar ni duplicar; ante la duda, el bot pregunta asertivamente.
