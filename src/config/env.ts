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
  ANTHROPIC_API_KEY: optional("ANTHROPIC_API_KEY", ""),
  ANTHROPIC_MODEL: optional("ANTHROPIC_MODEL", "claude-opus-5"),
  ANTHROPIC_EFFORT: optional("ANTHROPIC_EFFORT", "medium") as
    "low" | "medium" | "high" | "xhigh" | "max",
  // Conversaciones anteriores del cliente que Lucas lee por defecto al recomendar.
  LUCAS_DEFAULT_CONTEXT: Number(optional("LUCAS_DEFAULT_CONTEXT", "3")),
  // Horas sin mensajes tras las que se abre una conversación nueva con el cliente.
  LUCAS_CONVERSATION_GAP_HOURS: Number(optional("LUCAS_CONVERSATION_GAP_HOURS", "12")),
} as const;
