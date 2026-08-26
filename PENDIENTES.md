# Pendientes

> Lo que falta hacer, ordenado por lo que duele si no se hace.
> Al cerrar algo, borrarlo de aquí. Si aparece algo nuevo, va aquí y no en el chat.
> Última actualización: 26-08-2026.

## 0. Fase de envíos — DONDE QUEDAMOS (26-08-2026)

El objetivo: que el cliente sepa dónde va su pedido sin preguntar, y que la
hoja se actualice sola hasta "Entregado".

### Ya está hecho y probado

- **Shopify → CRM → hoja.** Una compra en la tienda crea el contacto y el
  pedido, y cae en "Confirmar pagos". Al apretar el botón sale a la hoja igual
  que un pedido de WhatsApp. Sirve para contra entrega y para tarjeta.
  Probado de punta a punta con el pedido #1162.
- **Columna No. Guía** en la hoja, al lado del Estado del pedido.
- **Números de la casa**: la tostaduría y el dueño escriben al número de la
  API sin que el bot les conteste, sin alerta de "necesita un humano" y sin
  contar como leads. Tabla `internal_numbers`, 8 números cargados.

### Lo que falta, en orden

**a) Leer el PDF de la guía.** La tostaduría manda al número de la API el PDF
de cada envío. Hay que sacar el número de guía y el destinatario, emparejarlo
con su fila y escribir el número en la columna No. Guía.
Regla: si el PDF no calza con ninguna fila, **dejar el hueco y avisar**. Nunca
adivinar a quién pertenece una guía.
*Bloqueado: falta un PDF de muestra para confirmar que el texto se deja leer y
no es un escaneo.*

**b) Avisarle al cliente.** Cuando una fila diga "Enviado" **y** tenga número
de guía, mandarle su número y `https://cargoexpreso.com/tracking/`.
Si el cliente escribió hace menos de 24h va mensaje normal (gratis); si no,
plantilla de utilidad primero. Un solo aviso por pedido, con el mismo candado
de `confirm_requested_at`.

**c) La ronda de las 6 de la tarde.** Con Chrome y la Mac abierta, revisar
todas las guías activas en Cargo Expreso y actualizar la hoja: En tránsito,
Devolución o Entregado.

### Lo que aprendimos investigando (no repetir el trabajo)

- **Cargo Expreso no tiene API pública.** El rastreo de la web no sirve por
  URL: `?guia=X` devuelve la página vacía, el resultado lo pinta JavaScript.
- Detrás hay un endpoint real: `POST https://www.entregoapp.com/api/envio/tracking/`
  con el campo `guia`. Devuelve `PODStatusDes` (el estado), `RemitenteNombre`,
  `DestinatarioNombre`, `PODFecha`, `PODHora` y los movimientos.
  Probado con la guía A417469997-1: devolvió ENTREGADO, Regina Cáceres,
  25/08 09:25. **No se pudo probar desde el servidor** (el navegador lo bloquea
  por CORS). Si responde servidor a servidor, la ronda de las 6 no necesita la
  Mac. Si no responde, queda con Chrome.
  Ese endpoint no está documentado: si lo cambian, se rompe. Conviene pedirle a
  Cargo Expreso acceso formal de integración.
- **La API de grupos de WhatsApp no sirve acá.** Solo puede *crear* grupos, no
  unirse a los que ya existen, y exige Cuenta Oficial de Empresa (la insignia),
  que Meta da por notoriedad de marca, no por cumplir requisitos. Por eso las
  guías van por mensaje directo al número de la API.

### Trampa que nos costó una fila hoy

**El Apps Script de la hoja corre una versión CONGELADA.** Guardar con Cmd+S no
alcanza: hay que ir a Implementar → Administrar implementaciones → lápiz →
Nueva versión → Implementar. Si no, los cambios no salen y las filas entran
corridas. Nos pasó con la columna No. Guía.

---


## 1. Seguridad de la base

### 1.1 Meterle la guardia por dentro a 6 funciones — PENDIENTE

El 21-08 se cerró el acceso **desde afuera** (revoke a `PUBLIC`, migración
`revoke_security_definer_from_public`). Eso tapa el agujero para quien llega sin
sesión, pero **no** arregla el fondo.

Estas 6 son `SECURITY DEFINER` (se saltan el RLS por diseño) y **no verifican quién
llama**:

| Función | Qué puede hacer un logueado de OTRA cuenta |
|---|---|
| `advance_pipeline_stages()` | mover de etapa el embudo entero |
| `merge_duplicate_contacts()` | fusionar contactos (no se deshace) |
| `merge_duplicate_conversations()` | fusionar conversaciones |
| `record_webhook_failure(uuid,int)` | sumar fallos hasta **desactivar** un webhook |
| `claim_ai_reply_slot(uuid,int)` | quemar el cupo de respuestas de IA |
| `_bcast_bump(uuid,text,int)` | alterar contadores de campaña |
| `recompute_broadcast_counts(uuid)` | recalcular contadores |

Falta agregarles al inicio:

```sql
IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
END IF;
```

Y en las que reciben un `uuid`, comprobar además que ese id **pertenece a la cuenta
de quien llama**. Hoy no lo comprueban.

**No tocar nunca:**

- `is_account_member` — la usan **98 políticas de RLS en 34 tablas**. Si se le quita
  el permiso, las consultas dejan de devolver cero filas y empiezan a fallar con
  "permission denied". Se cae el CRM entero.
- `peek_invitation` — tiene que correr sin sesión: es la que le muestra la
  invitación a alguien que todavía no tiene cuenta.

### 1.2 Cerrar también a `authenticated` — PENDIENTE

Las 6 de arriba las llama el cron o el servidor con llave de servicio, nunca el
navegador. Ya se **confirmó leyendo el código** que `claim_ai_reply_slot` sale de
`auto-reply.ts` con `supabaseAdmin()`, así que revocarle a `authenticated` es seguro.

---

## 2. Infraestructura

### 2.1 pg_cron saturado por el otro proyecto — PENDIENTE

El 21-08 hubo **1,089 corridas fallidas** con "job startup timeout". La causa no es
el CRM: son los trabajos de `fansbot` en la misma base.

| Trabajo | Frecuencia |
|---|---|
| `fansbot-perfilar` | cada minuto |
| `fansbot-motor-cola` | cada minuto |
| `repesca`, `avisos`, `sync-listas`, `fichas`, `titulares` | cada 2 minutos |

Entre todos se comen los procesos que Postgres tiene para tareas programadas y
`wacrm_tick` se queda sin turno. **Arreglo:** espaciar los de cada minuto a cada 2 o 3.

No afecta las respuestas del bot (el webhook de WhatsApp no pasa por pg_cron), pero
sí los timers del pipeline, la reconciliación con Meta y las difusiones programadas.

### 2.2 El tablero solo carga 1,000 tarjetas — PENDIENTE

PostgREST corta en 1,000 filas por defecto y ya hay 1,223 deals. Por eso Ganados
muestra **681 cuando en realidad son 898**, y Perdidos 238 en vez de 250. Los conteos
del tablero están mal desde que se pasó de las mil.

---

## 3. Inteligencia artificial

### 3.1 El camino de visión no registra su consumo — PENDIENTE

`image-reply.ts` nunca llama a `logAiUsage`. Son ~76 llamadas al mes (los
comprobantes de pago) que **no aparecen en ninguna estadística de gasto**.
Y ahora pesan más, porque corren en Sonnet 5.

### 3.2 Vigilar la calidad con Haiku — EN OBSERVACIÓN

Desde el 20-08 el texto corre en Haiku 4.5 y las imágenes en Sonnet 5
(columna `ai_configs.vision_model`). Haiku sigue instrucciones largas con menos
fidelidad. Si baja la calidad de la conversación, se revierte con una línea de SQL:

```sql
update ai_configs set model = 'claude-sonnet-4-5';
```

---

## 4. Meta / marketing

- **Verificar la primera compra atribuida vía CAPI.** Sigue sin confirmarse que Meta
  esté recibiendo y atribuyendo bien.
- **Fase 2:** retargeting de WhatsApp + público similar de compradores.
- **Decidir la regla del CAPI.** Hoy se le reportan a Meta *todas* las compras. Se
  midió que **el 45% son recompras orgánicas** que nunca vieron un anuncio — eso es
  ruido que ensucia el aprendizaje de la campaña.
- **WABA sin conectar al dataset** en Meta.

---

## 5. Menores

- **Etiqueta `Ganados`** — se creó el 15-08 solo para poder segmentar la difusión
  (el CRM no deja filtrar por columna del embudo). Decidir si se borra o se deja.
- **Resend:** dominio sin verificar.
- **npm:** 23 vulnerabilidades reportadas.


---

## 6. Seguros (MR Seguros)

El negocio de seguros vive en **otra cuenta dentro de este mismo CRM**, no en
otro sistema. Todo lo suyo está en `MANUAL-SEGUROS.md` — ahí van las fases, el
estado y el manual de negocio por llenar.

Hecho el 25-08-2026: cuenta creada, 510 contactos y 30 notas migrados, muro
verificado en las dos direcciones (cada cuenta ve 0 filas de la otra).

Lo que falta, en orden:

1. **Número de WhatsApp propio** — sin él no hay bot de seguros. El webhook
   enruta por `phone_number_id` y una cuenta no puede usar el número de otra.
2. **Cerebro del bot** — `ai_configs` de esa cuenta está vacío. Antes hay que
   llenar la sección 5 de `MANUAL-SEGUROS.md`.
3. **Etiquetas y embudo propios** — nacen vacíos, no se copian los del café.
4. **Cotizar en las plataformas de las aseguradoras** — sin decidir cómo.
5. **Llamadas de voz con IA** — la fase más lejana.
6. **Correo por puente en el CRM** — decidido que NO se usa conector de Gmail:
   el correo entra por webhook, se guarda como conversación en la cuenta
   Seguros y se responde por Resend. Depende de verificar el dominio en Resend
   (punto 5) y de agregarle un campo de canal a las conversaciones, que hoy
   asumen WhatsApp.

⚠️ **No proponer de nuevo** un CRM separado con su propia base y dominio, ni un
embudo de seguros dentro de la cuenta del café. Los dos caminos se evaluaron y
se descartaron; el porqué está en `MANUAL-SEGUROS.md` sección 2.
