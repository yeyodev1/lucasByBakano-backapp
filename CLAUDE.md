# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `pnpm dev` (ts-node-dev con auto-restart, puerto 8100)
- **Build:** `pnpm build` (tsc → `dist/`)
- **Start prod:** `pnpm start`
- **Format:** `pnpm format` (Prettier)
- **Seed admin:** `pnpm seed:admin`
- **No hay linter ni tests.** `pnpm build` es la única verificación.

## Tech Stack

- Express 5 + TypeScript (CommonJS, target ES2024)
- MongoDB via Mongoose (`DB_URI`)
- JWT Bearer (`JWT_SECRET`, 30 días)
- Resend para correo (opcional: sin key no envía)
- Vercel: `api/index.ts` es la función; `vercel.json` reescribe todo a `/api`

## Architecture

### Request Flow

`Express app → CORS → JSON parser (50mb) → /api router → handlers → globalErrorHandler`

### Layered Structure

- **Routes** (`src/routes/`) — definen endpoints, aplican `authMiddleware`, delegan al controller
- **Controllers** (`src/controllers/`) — parsean req, llaman al service, responden. Sin lógica de negocio.
- **Services** (`src/services/`) — lógica de negocio y APIs externas. Lanzan `CustomError`.
- **Models** (`src/models/`) — schemas Mongoose

### Key Patterns

- **Env:** solo `src/config/env.ts` lee `process.env`. No lo leas en otro archivo.
- **Errores:** `throw new CustomError("Mensaje en español", 404)`; `globalErrorHandler` responde `{ message }` y avisa a Slack en 5xx.
- **Auth:** `authMiddleware` verifica el Bearer y deja `req.user` (`AuthRequest`). Gates de rol van después (`adminMiddleware`).
- **Respuestas:** cuerpo desnudo (`res.json(item)`), paginación `{ items, total, page, pages }`, login `{ token, user }`.
- **Mongo serverless:** `dbConnect()` cachea la promesa; nunca `process.exit` en Vercel.

## Convenciones

- Comillas dobles, punto y coma, 2 espacios. Prettier lo aplica.
- Exports nombrados. La única excepción son los routers (`export default router`).
- Archivos camelCase + sufijo con punto: `product.controller.ts`, `product.routes.ts`, `product.service.ts`, `product.model.ts`, `auth.middleware.ts`.
- Controllers se importan como namespace: `import * as productController from "../controllers/product.controller"`.
- Identificadores genéricos en inglés; dominio, comentarios, mensajes y commits en español.
- Comentarios explican el porqué, no el qué.
