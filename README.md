# Lucas API

Express 5 + Mongoose + TypeScript. Se despliega en Vercel como función serverless.

## Setup local

```bash
pnpm install
cp .env.example .env         # rellenar DB_URI, JWT_SECRET, ADMIN_PASSWORD
pnpm dev                     # http://localhost:8100
```

Smoke:

```bash
curl http://localhost:8100/
curl http://localhost:8100/api/health
curl -X POST http://localhost:8100/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cliente.com","password":"..."}'
```

## Scripts

| Script | Qué hace |
|---|---|
| `pnpm dev` | ts-node-dev con recarga |
| `pnpm build` | `tsc` → `dist/` |
| `pnpm start` | `node dist/index.js` |
| `pnpm seed:admin` | crea/actualiza la cuenta admin desde `.env` |
| `pnpm format` | prettier |

## Endpoints

Todo cuelga de `/api` (`src/routes/index.ts`).

- `GET /` → alive
- `GET /api/health` → `{ ok, db, uptime }`
- `POST /api/auth/login` → `{ token, user }`
- `GET /api/auth/me` → `{ user }` (Bearer)
- `PUT /api/auth/password` → `{ user }` (Bearer) body `{ current, next }`

## Deploy a Vercel

- `api/index.ts` — entrada serverless: conecta Mongo, siembra admin y delega en la app Express.
- `vercel.json` — todo el tráfico se reescribe a `/api`.

Variables de entorno (Vercel → Project → Settings → Environment Variables): las mismas de `.env.example`.

```bash
vercel --prod
```

## Lucas: bot de Telegram (@LucasByBakanoBot)

Copiloto de ventas: lee conversaciones con clientes, las guarda en el CRM (Mongo) y recomienda qué responder. La IA corre con el AI SDK sobre Vercel AI Gateway (`AI_MODEL` = "proveedor/modelo", `AI_GATEWAY_API_KEY` en local, OIDC en Vercel), igual que el bot de métricas.

**Cómo le llegan las conversaciones**

- Capturas de pantalla (WhatsApp, Instagram, etc.): Claude las transcribe, identifica al cliente y lo crea si no existe.
- Texto pegado.
- Mensajes reenviados de Telegram.
- Telegram Business: el operador conecta el bot en Ajustes → Telegram Business → Chatbots y Lucas lee sus chats privados. Nunca le responde al cliente; solo avisa al operador.

**Contexto:** cada operador elige cuántas conversaciones anteriores lee Lucas (`/contexto n`, o `/sugerir n` para una sola vez). Una conversación nueva empieza tras `LUCAS_CONVERSATION_GAP_HOURS` horas de silencio.

**Acceso:** solo operadores vinculados con `/vincular <TELEGRAM_LINK_CODE>`.

```bash
pnpm bot                                   # local, modo polling (sin URL pública)
pnpm telegram:webhook https://<backend>    # producción: registra el webhook y el menú
pnpm telegram:webhook --delete
```

API de administración (Bearer de admin): `/api/clients`, `/api/conversations/:id`, `/api/settings/business`.
