import "dotenv/config";

/**
 * Único lugar que lee process.env. Leerlo en otro archivo a nivel de módulo
 * es el bug clásico de "la variable está en .env pero llega undefined".
 */

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function list(key: string): string[] {
  return optional(key, "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export const env = {
  PORT: Number(optional("PORT", "8100")),
  NODE_ENV: optional("NODE_ENV", "development"),
  IS_VERCEL: Boolean(process.env.VERCEL),
  DB_URI: required("DB_URI"),
  JWT_SECRET: required("JWT_SECRET"),
  CORS_ORIGINS: list("CORS_ORIGINS"),
  FRONTEND_URL: optional("FRONTEND_URL", "http://localhost:5173"),
  SLACK_ERROR_WEBHOOK: optional("SLACK_ERROR_WEBHOOK", ""),
  ADMIN_EMAIL: optional("ADMIN_EMAIL", "admin@cliente.com").toLowerCase(),
  ADMIN_PASSWORD: optional("ADMIN_PASSWORD", ""),
  ADMIN_NAME: optional("ADMIN_NAME", "Administración"),
  RESEND_API_KEY: optional("RESEND_API_KEY", ""),
  RESEND_FROM_EMAIL: optional("RESEND_FROM_EMAIL", "Lucas <onboarding@resend.dev>"),
  CLOUDINARY_CLOUD_NAME: optional("CLOUDINARY_CLOUD_NAME", ""),
  CLOUDINARY_API_KEY: optional("CLOUDINARY_API_KEY", ""),
  CLOUDINARY_API_SECRET: optional("CLOUDINARY_API_SECRET", ""),
  CRON_SECRET: optional("CRON_SECRET", ""),
  TELEGRAM_BOT_TOKEN: optional("TELEGRAM_BOT_TOKEN", ""),
  TELEGRAM_WEBHOOK_SECRET: optional("TELEGRAM_WEBHOOK_SECRET", ""),
  // Código que un miembro del equipo manda con /vincular para poder usar a Lucas.
  TELEGRAM_LINK_CODE: optional("TELEGRAM_LINK_CODE", ""),
  // Vercel AI Gateway: en Vercel autentica solo por OIDC; fuera de Vercel usa la llave.
  AI_GATEWAY_API_KEY: optional("AI_GATEWAY_API_KEY", ""),
  AI_MODEL: optional("AI_MODEL", "anthropic/claude-opus-5"),
  // Tope por llamada a la IA. Telegram reintenta si tardamos; el reintento se descarta.
  AI_LIMITE_MS: Number(optional("AI_LIMITE_MS", "120000")),
  // Metrics (solo lectura): entornos de los clientes de Bakano. Vacío = Lucas funciona sin ese contexto.
  METRICS_DB_URI: optional("METRICS_DB_URI", ""),
  METRICS_DB_NAME: optional("METRICS_DB_NAME", "test"),
  // Finanzas (finances-bakano-backapp): saldos y links de pago de Stripe. Mismo API y
  // llave (x-metrics-key) que usa Metrics para el portal de facturación.
  FINANCES_API_URL: optional("FINANCES_API_URL", ""),
  FINANCES_PORTAL_KEY: optional("FINANCES_PORTAL_KEY", ""),
  // A dónde vuelve el cliente después de pagar en Stripe.
  PAGO_RETURN_URL: optional("PAGO_RETURN_URL", "https://bakano.ec"),
  // Conversaciones anteriores del cliente que Lucas lee por defecto al recomendar.
  LUCAS_DEFAULT_CONTEXT: Number(optional("LUCAS_DEFAULT_CONTEXT", "3")),
  // Horas sin mensajes tras las que se abre una conversación nueva con el cliente.
  LUCAS_CONVERSATION_GAP_HOURS: Number(optional("LUCAS_CONVERSATION_GAP_HOURS", "12")),
} as const;
