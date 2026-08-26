# MR Seguros — manual de negocio y traspaso

> Hermano de `MANUAL.md` (café). **Lo técnico NO se duplica**: el código, la base
> y el despliegue son los mismos para los dos negocios y viven en `CLAUDE.md`.
> Aquí va solo lo de seguros.
>
> **Antes de tocar nada, leé `CLAUDE.md` y `PENDIENTES.md`.** Ahí están las
> trampas ya conocidas: el build de Hostinger typechea y esbuild no, Hostinger
> reemplaza el dominio en vez de sumarlo, el prefijo del prompt se cachea y hay
> que mantenerlo idéntico, etc. Repetir esos errores cuesta días.
>
> Creado el 25-08-2026, cuando se separaron los dos negocios.

---

## 1. Cómo está montado (leer completo antes de proponer cambios)

Un solo CRM, un solo dominio, una sola base. **Dos cuentas.**

| | Café | Seguros |
|---|---|---|
| Cuenta | `Charles Moll` | `MR Seguros` |
| account_id | `1fafc601-0d10-4a07-80da-9a99cafd9f9f` | `1d9c8361-da05-4771-900e-cdba7c49cbed` |
| Usuario | jcmollf@gmail.com | jcmollf+seguros@gmail.com |
| Contactos | 1,378 | 510 |

**Qué comparten:** el repositorio, el servidor de Hostinger, el dominio
crm.kaffeejager.shop y la base de Supabase.

**Qué NO comparten:** contactos, conversaciones, etiquetas, embudos, difusiones,
número de WhatsApp, y **el cerebro del bot** (`ai_configs`: prompt, modelo y base
de conocimiento son por cuenta).

### La separación es real, no cosmética

98 políticas de RLS en 34 tablas filtran por `account_id`. Se verificó el
25-08-2026 consultando la base como cada usuario:

```
usuario de seguros pidiendo todo -> 510 contactos suyos, 0 de café
                                    0 conversaciones, 0 deals, 0 etiquetas
usuario de café pidiendo todo    -> 1,378 contactos suyos, 0 de seguros
```

No es la pantalla escondiendo filas: la base se niega a entregarlas. Una
asistente de seguros no ve café ni escribiendo la URL a mano.

### Un usuario = una cuenta

La membresía vive en `profiles.account_id` y hay un índice único
(`idx_accounts_one_per_owner`) que impide dos cuentas por dueño. Para cambiar de
negocio hay que **cerrar sesión y entrar con el otro correo** (o usar una ventana
de incógnito). No existe selector de cuentas en la interfaz.

⚠️ Si alguien pide "un botón para saltar entre cuentas": eso obliga a que un
usuario pertenezca a dos cuentas, y **ahí el muro deja de ser absoluto**. Se
puede hacer solo para el dueño, pero es la pieza que sostiene la separación —
no se toca a la ligera.

---

## 2. Caminos ya descartados (no volver a proponerlos)

**Un CRM aparte, con su propio Supabase y dominio.** Significa duplicar cada
arreglo: el candado del nombre, la regla del envío, la verificación de sumas,
la hoja de pedidos. Cada bug se arregla dos veces y se desincronizan. Además:
otro plan de Supabase, otro dominio, otro sitio, otra app de Meta.

**Un embudo nuevo dentro de la cuenta del café.** Deja compartidos los
contactos, las etiquetas, las difusiones y el mismo bot. Es exactamente lo que
se quería evitar.

---

## 3. Estado hoy

Lo que ya existe:

- Cuenta creada y 510 contactos migrados, con sus 30 notas.
- La etiqueta vieja `otro-negocio-seguros` ya no se usa: **estar en la cuenta ES
  el marcador**.

Lo que está vacío y hay que construir:

- Sin número de WhatsApp conectado (`whatsapp_config`).
- Sin configuración de IA (`ai_configs`): **el bot de seguros no existe todavía**.
- Sin embudo, sin etiquetas, sin difusiones.

### Dos contactos que se quedaron en café a propósito

**Oscar Donis** (50241680005) y **María** (50237475000). Están en la lista de
seguros pero sus conversaciones son de café — Oscar preguntó precios del café y
a María el bot le confirmó una transferencia de Q70. Moverlos habría borrado
esos chats del inbox del café. Si algún día se pasan a seguros, se van con el
chat: hay que decidir cuál historia importa más.

---

## 4. Fases pendientes

1. **Número de WhatsApp propio.** Obligatorio y no negociable: el webhook enruta
   por `phone_number_id` y hay un candado que impide que dos cuentas reclamen el
   mismo número. Sin número aparte no hay bot de seguros.
2. **Cerebro del bot.** Prompt del sistema + base de conocimiento en la cuenta de
   seguros. Es trabajo de producto: hay que escribir la sección 5 de este manual
   primero.
3. **Etiquetas propias.** Nacen vacías, no se copian las del café.
4. **Mensajes masivos.** Funciona igual que en café, pero ojo: el CRM no permite
   segmentar por columna del embudo, solo por etiqueta. En café hubo que crear
   una etiqueta `Ganados` a mano para poder segmentar.
5. **Cotizar en las plataformas de las aseguradoras.** Desarrollo nuevo, sin
   decidir cómo (navegador automatizado vs. API si alguna la tiene).
6. **Llamadas de voz con IA.** Desarrollo nuevo, la fase más lejana.
7. **Correo.** Decidido: **puente dentro del CRM**, no conector de Gmail. El
   correo entrante cae en un webhook, se guarda como conversación en la cuenta
   Seguros y se responde por Resend. Ventaja: queda bajo las mismas políticas de
   RLS que todo lo demás. Requiere verificar el dominio en Resend y agregarle un
   campo de canal a las conversaciones, que hoy asumen WhatsApp.

---

## 5. El negocio (POR LLENAR)

> Esta sección es el equivalente al catálogo de café. Mientras esté vacía, el
> bot de seguros no puede trabajar. Lo que se escriba aquí va también al prompt
> del sistema de la cuenta de seguros.

### Aseguradoras con las que se trabaja
_pendiente_

### Productos y coberturas
_pendiente — qué se vende, qué cubre cada cosa, qué NO cubre_

### Cómo se cotiza
_pendiente — en qué plataforma, qué datos hay que pedirle al cliente,
cuánto tarda_

### Datos que SIEMPRE hay que pedir antes de cotizar
_pendiente — el equivalente a la "regla del nombre" del café: sin estos datos
no se avanza_

### Precios y comisiones
_pendiente_

### Documentos que el cliente debe enviar
_pendiente_

### Reglas que el bot nunca debe romper
_pendiente — el café tiene tres: el envío siempre suma Q45, solo se da una
cuenta bancaria, y sin nombre no se cierra el pedido. Seguros necesita las
suyas, y conviene que sean candados en código, no solo texto en el prompt._

---

## 6. Lección del café que aplica igual aquí

Los errores caros del café **no fueron por falta de inteligencia del modelo**.
Fueron por falta de candado en el código:

- Un total sin sumarle el envío.
- Un nombre que no se guardaba y dejaba el pedido sin rotular.
- El modelo inventándose números de cuenta bancaria.

Los tres se arreglaron con verificaciones deterministas antes de enviar, no
pidiéndole al modelo que se portara mejor. En seguros la plata es más grande:
**cualquier cifra o dato legal que el bot diga, verificarlo en código.**
