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
