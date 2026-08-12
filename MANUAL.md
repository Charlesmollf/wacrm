# MANUAL — Kaffeejager Roastery

> Verdad única del **negocio**: catálogo, precios y reglas de venta.
> Lo técnico (código, base de datos, deploy) va en `CLAUDE.md`.
> Última verificación contra Shopify: 12-08-2026.
>
> Al cambiar algo aquí, reflejarlo también en:
> `ai_configs.system_prompt` (bloque `=== CATALOGO OFICIAL`) y en `ai_knowledge_chunks` (chunks 10 y 11).

## 1. Negocio

Tostaduría familiar, 5 generaciones desde 1913. Finca Santa Elisa, Cobán, Alta Verapaz.
Variedades casi extintas, tostado semanal. Tienda: https://kaffeejager.shop · Venta principal por WhatsApp.

## 2. Precios

**Todos los precios de esta sección son SIN ENVÍO.**
### Bolsas de 400 gr

| Precio | Variedades |
|---|---|
| Q120 | Bourbon · Catuaí · Caturra Roja · Pacamara · Maracaturra · Maragogipe · Peaberry (Caracolillo) · Anaeróbico |
| Q120 | Café con Cardamomo — **solo molido** |
| Q200 | Gesha · Kenia SL28 (premium) |

### Combos (grano o molido al mismo precio, todos con caja de regalo)

| Combo | Contenido | Solo | + Prensa | + Cafetera |
|---|---|---|---|---|
| Colosos de América | Pacamara + Maracaturra + Maragogipe | Q345 | Q445 | Q545 |
| Intensa Dulzura | Pacamara + Catuaí + Anaeróbico | Q345 | Q445 | Q545 |
| Mítico Cobán | Bourbon + Catuaí + Caturra Roja | Q345 | Q445 | Q545 |
| África Mía | Gesha + Kenia SL28 | Q400 | Q500 | Q545 ⭐ |
| Procesos Secretos | Anaeróbico + Peaberry | Q240 | **Q260** ⭐ | Q440 |
| Combo #4 Highland Cobán | 4 variedades de la región | Q220 | Q320 | Q440 |

⭐ Las dos gangas que siempre hay que mencionar: **Procesos Secretos + prensa por solo +Q20**
(normalmente cuesta Q100) y **África Mía + cafetera en Q545**.

### Accesorios (nunca se venden solos)

- Prensa Francesa **+Q100** · excepción: Procesos Secretos **+Q20**
- Cafetera Italiana (Moka) **+Q200** · excepción: África Mía queda en Q545
- La cafetera **nunca** cuesta Q100 — ese es el precio de la prensa

## 3. ⚠️ Envío y totales — la regla que más se rompe

**Q45 a toda Guatemala. UN SOLO envío por pedido**, sin importar cuántos productos lleve.
Entrega en 24–48 horas hábiles con Cargo Expreso.

> **Total = precio del café + Q45. Siempre.**
> Antes de decir un total, revisar: si ese número aparece tal cual en la tabla de arriba,
> **faltó sumar el envío**.

| Pedido | Café | Total real |
|---|---|---|
| África Mía con cafetera italiana | Q545 | **Q590** |
| África Mía sola | Q400 | **Q445** |
| Mítico Cobán | Q345 | **Q390** |
| Procesos Secretos con prensa | Q260 | **Q305** |
| Una bolsa de 400 gr | Q120 | **Q165** |

Al cliente se le desglosa: *"Q545 + Q45 de envío = Q590"*.

## 4. Pago

1. **Link de pago** (solo VISA): https://sp.pagalo.co/kaffeejager-roastery
2. **Transferencia — ÚNICA CUENTA QUE EXISTE:**
   BAM (Banco Agromercantil) · **Cuenta Monetaria 30-3093873-2** · Kaffeejager Roastery
   🚫 Prohibido dar cualquier otro número. Jamás inventar ni completar.
3. **Contra entrega**

Tras pagar, el cliente manda el comprobante. El pago lo confirma **una persona**, nunca el bot.

## 5. Datos del pedido

**Nombre** · Teléfono · Correo · Dirección exacta · Grano o molido · NIT (si quiere factura)

- **El nombre es obligatorio**: sin él no se puede rotular la guía de Cargo Expreso, así que
  ningún pedido entra a "Confirmar pagos" sin nombre. Si falta, se pide antes de cerrar.
- Si el cliente ya está en la cartera, esos datos **ya los tenemos**: se **confirman**, no se piden
  de cero.

## 6. Reglas de oro al vender

1. Cada dato que da el cliente se guarda en su ficha; **no se le repite de vuelta**.
2. Respuestas de una o dos líneas pidiendo solo lo que falta. El resumen completo va **una sola vez**,
   al cerrar, antes de preguntar la forma de pago.
3. Al preguntar "¿qué incluye?": contenido **y** las tres opciones con su precio.
4. Nunca inventar precios, productos ni cuentas. Si no está en este manual, no existe.
5. Cliente que ya compró y manda fotos = **seguimiento post-venta**, no se le vuelve a vender.
6. Pregunta por un pedido días después = **el mismo pedido**, no uno nuevo.
7. Ante la duda, preguntar antes de asumir.
