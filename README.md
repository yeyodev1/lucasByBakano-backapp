# Lucas · agente de ventas de Bakano

Lucas es el agente de ventas que [Bakano](https://bakano.ec) le da a sus clientes: negocios en Ecuador que venden por WhatsApp. El dueño o sus vendedores le pasan la conversación con un cliente por Telegram ([@LucasByBakanoBot](https://t.me/LucasByBakanoBot)) y Lucas les dice:

- **qué responder** para cerrar la venta, con 2 o 3 opciones listas para copiar;
- **qué tan cerca están de cerrar**: frío, tibio, caliente o listo para pagar, con porcentaje y lo que falta;
- **cuándo mandar el pago**, con el mensaje ya armado con sus datos de pago;
- y siempre respeta **las reglas del negocio**, por ejemplo "no se envían proformas para montos menores a $500".

Escribe como un buen vendedor ecuatoriano por WhatsApp: frases cortas, emojis donde suman, signos de pregunta solo al final y nada de frases de oficina.

## Cómo se usa

**Quién puede usarlo:** los clientes de Bakano con su entorno **activo** en [metrics.bakano.ec](https://metrics.bakano.ec). Si el entorno está inactivo (falta de pago, fin de contrato…), Lucas le dice que no tiene acceso. El equipo de Bakano siempre entra.

**Cómo entra un cliente (sin códigos):**

1. Escribe a [@LucasByBakanoBot](https://t.me/LucasByBakanoBot).
2. Si ya usa el bot de Bakano (@BakanoAgencyBot), Lucas lo reconoce por su Telegram y lo vincula solo.
3. Si no, Lucas le pide el correo con el que entra a metrics.bakano.ec, le manda un código de 6 dígitos a ese correo y listo.
4. Si su negocio todavía no existe en Lucas, se crea enlazado a su entorno de Metrics (Lucas toma de ahí productos, ticket promedio y tono). El admin del entorno queda como dueño y los colaboradores como vendedores. Si tiene varios negocios, elige con cuál trabajar.

El dueño configura su negocio una vez: `/negocio` (qué vende y a qué precio), `/pago` (sus datos de pago) y `/regla` (sus condiciones). Desde ahí, cada captura de WhatsApp o conversación pegada devuelve la lectura de la venta y las respuestas.

El equipo de Bakano entra con `/vincular <TELEGRAM_LINK_CODE>` (o con su correo de Metrics si es usuario interno) y puede dar de alta negocios con `/alta`, que solo acepta entornos activos.

### Comandos

| Comando | Qué hace |
|---|---|
| `/calientes` | Los clientes más cerca de comprar |
| `/ventas` | Cómo va el mes: facturación registrada en Metrics, ROAS y lo que falta cerrar |
| `/cliente <nombre o teléfono>` · `/nuevo <nombre \| teléfono>` | Buscar o crear un cliente |
| `/ficha` · `/nota` · `/etapa` | Ficha del cliente activo |
| `/sugerir [n] [pedido]` | Qué responder; `n` = conversaciones anteriores a leer |
| `/contexto <n>` | Cuántas conversaciones anteriores lee por defecto |
| `/negocio` · `/pago` · `/regla` · `/reglas` | Configuración del negocio |
| `/alertas` · `/alertasaqui` | A dónde llegan los avisos (en un grupo del equipo: `/alertasaqui`) |
| `/alta` · `/negocios` · `/codigo` · `/cobros` · `/crm` | Solo equipo Bakano |

### Avisos

Lucas le avisa al dueño del negocio (o a su grupo):

- un cliente escribió por Telegram Business y nadie le respondió en `LUCAS_SLA_MINUTOS`;
- un vendedor atendió mal (respuesta seca, información falsa, prometió de más);
- un cliente está molesto o en riesgo;
- **cierres casi solos**: la revisión diaria del CRM del negocio (en Metrics → Integraciones) encontró leads que dieron todo para comprar y no se cerraron.

El mismo aviso no se repite. El equipo de Bakano recibe su propio resumen para dar seguimiento.

## Cómo está hecho

```
Telegram ──webhook──▶ /api/telegram/webhook ──▶ lucas.service (comandos, capturas)
                                                   │
                     ┌─────────────────────────────┼──────────────────────────────┐
                     ▼                             ▼                              ▼
             CRM de Lucas (Mongo)        IA (AI SDK + Vercel AI Gateway)    Metrics (solo lectura)
       negocios, leads, conversaciones,   lee capturas y recomienda        perfil del negocio, facturación,
       sugerencias, avisos                                                 CRM y cierres casi solos
```

- **Stack:** Express 5 + Mongoose + TypeScript, desplegado en Vercel como función serverless (`api/index.ts`).
- **IA:** [AI SDK](https://ai-sdk.dev) sobre [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). El modelo se cambia con `AI_MODEL` (`proveedor/modelo`), sin tocar código. En Vercel se autentica con OIDC; en local con `AI_GATEWAY_API_KEY`.
- **Multi-negocio:** todo cuelga de `Negocio`. Leads, capturas, reglas y avisos de un negocio nunca se mezclan con los de otro.
- **Metrics:** Lucas lee la base de [metrics.bakano.ec](https://metrics.bakano.ec) en modo solo lectura (`METRICS_DB_URI`).
- **Idempotencia:** Telegram reintenta el webhook si la IA tarda; cada `update_id` se procesa una sola vez.

### Estructura

```
src/
  models/        negocio, operator, client (lead), conversation, message, suggestion, alert…
  services/
    lucas.service.ts           comandos y flujo del bot
    capture.service.ts         capturas, texto pegado, reenvíos y Telegram Business
    recommendation.service.ts  arma la recomendación y la manda
    ai.service.ts              prompts y llamadas a la IA
    negocio.service.ts         negocios, reglas y datos de pago
    metrics.service.ts         lectura de Metrics
    alert.service.ts · monitor.service.ts   avisos y vigilancia
  routes/ controllers/         webhook, cron y API de administración
  scripts/                     polling local y registro del webhook
```

## Ambientes

| Rama | Ambiente | Bot | Base |
|---|---|---|---|
| `main` | Producción (Vercel production) | @LucasByBakanoBot por webhook | `lucas` |
| `develop` | Pruebas (Vercel preview) | sin webhook: se prueba en local con `pnpm bot` o con un bot de pruebas | `lucas-dev` |

Se trabaja en `develop` y se pasa a producción con un merge a `main`. Vercel despliega cada push.

## Correr en local

```bash
pnpm install
cp .env.example .env   # completar variables
pnpm dev               # API en http://localhost:$PORT
pnpm bot               # Lucas escuchando Telegram en modo polling (quita el webhook mientras corre)
```

`pnpm bot` y el webhook de producción no pueden correr a la vez con el mismo bot: al terminar de probar en local, vuelve a registrar el webhook con `pnpm telegram:webhook https://lucas-by-bakano-backapp.vercel.app`.

### Variables de entorno

Todas están en `.env.example` sin valores. Solo `src/config/env.ts` lee `process.env`.

| Grupo | Variables |
|---|---|
| Base | `DB_URI`, `PORT`, `JWT_SECRET`, `CORS_ORIGINS`, `FRONTEND_URL`, `SLACK_ERROR_WEBHOOK` |
| Admin del API | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_LINK_CODE` (código del equipo Bakano) |
| IA | `AI_GATEWAY_API_KEY` (solo local), `AI_MODEL`, `AI_LIMITE_MS` |
| Metrics | `METRICS_DB_URI`, `METRICS_DB_NAME`, `METRICS_APP_URL` |
| Finanzas (cobros de Bakano) | `FINANCES_API_URL`, `FINANCES_PORTAL_KEY`, `PAGO_RETURN_URL` |
| Lucas | `LUCAS_DEFAULT_CONTEXT`, `LUCAS_CONVERSATION_GAP_HOURS`, `LUCAS_SLA_MINUTOS`, `CRON_SECRET` |
| Correo | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` |

## Despliegue

```bash
vercel --prod                                       # o push a main
pnpm telegram:webhook https://lucas-by-bakano-backapp.vercel.app   # registra el webhook y el menú del bot
```

El cron `/api/cron/lucas` (cada 30 min, en `vercel.json`) avisa de clientes sin respuesta y de los hallazgos diarios del CRM. Vercel lo llama con `Authorization: Bearer $CRON_SECRET`.

### API de administración

Detrás de login de admin (`POST /api/auth/login`): `/api/clients?negocio=<id>`, `/api/conversations/:id`. `pnpm build` es la única verificación (no hay tests ni linter).
