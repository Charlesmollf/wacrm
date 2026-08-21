# wacrm — Mapa técnico (Kaffeejager Roastery)

CRM de WhatsApp (Next.js + Supabase). **El catálogo, los precios y las reglas de venta viven en
`MANUAL.md`** — no duplicarlos aquí.
**Lo que falta por hacer vive en `PENDIENTES.md`** — al cerrar algo, borrarlo de ahi.

- Deploy: push a main -> Hostinger auto-deploy (~5-10 min) en **crm.kaffeejager.shop**. El dominio viejo aqua-gaur-598822.hostingersite.com ya no existe: Hostinger lo reemplaza, no lo suma.
- Supabase: `gxugzprqrbtdaligkzld` · migraciones a mano en el SQL editor
- GitHub Actions deshabilitado a propósito (el reloj real es pg_cron, ver §4)
- **Antes de subir: `npx tsc --noEmit`.** El build de Hostinger sí typechea; esbuild no.
  Un error de tipos deja el sitio sirviendo la versión vieja y la ruta nueva en 404, sin aviso.

## 1. Camino de un mensaje

1. **`api/whatsapp/webhook/route.ts`** — entrada de Meta. Captura `ctwa_clid` (anuncios
   Click-to-WhatsApp), detecta comprobantes de pago, reabre chats cerrados si el cliente escribe.
2. **`lib/ai/auto-reply.ts`** — respuesta de texto. Debounce 5 s (varios mensajes seguidos → una
   sola respuesta). Arma el prompt en dos partes: prefijo estable (cacheado) + ficha y pedido.
3. **`lib/ai/image-reply.ts`** — mismo flujo para fotos y stickers, con historial y `postSale`.
4. **`lib/ai/customer-file.ts`** — la ficha: qué datos hay, cuáles faltan y la regla de estilo que
   impide repetir el resumen en cada mensaje.
5. **`lib/ai/deal-updates.ts`** — parsea `[[SET: ...]]` y escribe el pedido.
6. **`api/payments/confirm/route.ts`** — "Pagado" a mano → Purchase a Meta + tarjeta a Enviado.

## 2. Reglas de negocio que viven en código

- `deal-updates.ts` **nunca crea deals**: actualiza el más reciente del contacto.
- `total` nuevo = venta nueva. Un pedido ya Pagado no regresa a "Por confirmar" sin total nuevo.
- **Sin nombre del cliente el pedido no entra a "Confirmar pagos"** (se queda en Pendiente).
- Contra entrega confirmado → siempre "Por confirmar" (trigger `trg_enforce_cod_payment_status`).
- Cuenta bancaria: `enforce_bank_account()` en `auto-reply.ts` reescribe cualquier cuenta que no
  sea 30-3093873-2. El bot ya inventó cuentas una vez; el candado es de código, no de prompt.
- Cliente con etiqueta "Cliente viejo" nunca va a Perdidos: regresa a Ganados.

## 3. Prompt e IA

- Prompt del bot: `ai_configs` id `76fc3b2b-106d-45ed-a072-c12fc7b17b2d`, bloque
  `=== CATALOGO OFICIAL`. Se edita en la base, no requiere deploy.
- Base de conocimiento: `ai_knowledge_chunks` (10 fragmentos, sin embeddings). Se manda **completa**
  dentro del prefijo cacheado; ya no se busca por palabras clave (la búsqueda fallaba y además
  rompía el caché).
- **Caché de prompts**: `providers/anthropic.ts` parte el system en bloque estable (cacheado, TTL 1h)
  + volátil. El prefijo debe ser idéntico byte por byte: cualquier dato variable va DESPUÉS.
  Verificación: `GET /api/ai/cache-check` (admin) — la 2ª llamada debe leer del caché.

## 4. Relojería

`pg_cron` dentro de Supabase llama a `/api/cron/tick?token=` (token en `app_cron_auth`).
24/7: timers del pipeline y reconciliación de compras a Meta.
Solo L-V 7:00–21:00 GT: difusiones, seguimiento a leads fríos y pasos de automatizaciones.

## 5. Base de datos — trampas

- `messages`: `content_text` / `content_type` (**no** `content` ni `body`).
- `contact_notes`: `note_text` (**no** `content`). Este error dejó al bot sin ver el historial de Kommo.
- `contacts`: `name` es el editable; `wa_profile_name` es la línea base para saber si alguien
  renombró a mano. WhatsApp reenvía el nombre del perfil en cada mensaje.
- `deals`: `combo_history` (líneas `[YYYY-MM-DD] producto`), `sold_at` (fecha real de venta),
  `capi_status` / `capi_sent_at` / `capi_error` / `capi_attempts`.
- **`updated_at` no es fecha de venta.** Tocar deals viejos en masa los hizo aparecer como ventas
  de hoy en el dashboard. Usar siempre `sold_at`.
- `execute_sql` del MCP solo devuelve el resultado de la última sentencia.

## 6. Meta Ads / CAPI

- Dataset `1066253287683027`. Con `ctwa_clid` → `business_messaging` (determinístico);
  sin él → `website` con matching avanzado (teléfono/nombre hasheados).
- `event_id = deal_<id>` deduplica. **Meta rechaza eventos de más de 7 días.**
- Reconciliador diario reintenta lo que falló (ventana de 7 días, máx. 6 intentos).
- Cuenta act_1418677364993352 · business 2088994378032233 · campaña "Ventas CRM/Claude - Whatsapi".
- Pendiente: conectar la WABA al dataset para atribución determinística real.

## 7. Lecciones (no repetir)

- `router.replace()` puede ser no-op silencioso → `window.history.replaceState`.
- Revisar el array de deps de `useCallback` al agregar estado.
- Resend con `onboarding@resend.dev` cae en spam → falta verificar dominio propio.
- Shopify contra entrega queda PENDING y el pixel no dispara Purchase; por eso el envío server-side.
- Meta acepta difusiones y luego capa frecuencia sin error visible.
- Difusiones grandes: lotes reanudables (`scheduled-broadcast.ts`), no de un tirón.


## 8. Hoja de la tostaduria (Google Sheet)

Hoja **Pedidos Kaffeejager** (pestania `Pedidos`): titulo en filas 1-3, encabezados en la 4,
los pedidos entran **siempre en la fila 5** (el mas nuevo arriba).

- Al marcar **Pagado** en `/payments`, `lib/sheets/push-order.ts` hace POST al Apps Script.
- La URL y el token viven en `whatsapp_config.sheets_webhook_url` / `sheets_webhook_token`.
  **No estan en el codigo.**
- Corre en el servidor (Hostinger): funciona con la Mac apagada.
- El script deduplica por `deal_id` (columna oculta M) y repone los desplegables
  (Estado: Pendiente rojo / En proceso amarillo / Enviado verde · Grano o molido).
- La fecha es la de la **venta** (`sold_at`), no la de la confirmacion.
- Es best-effort: si la hoja falla el pago igual queda confirmado; la respuesta trae `hoja: {...}`.
- **Si tocas el Apps Script hay que implementar una version nueva**, si no el `/exec`
  sigue sirviendo la version vieja.
