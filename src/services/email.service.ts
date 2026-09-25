import { Resend } from "resend";
import { env } from "../config/env";

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

/**
 * Envía un correo. Nunca lanza: el fallo de un correo no debe romper el
 * flujo que lo disparó (una compra, un registro). Devuelve si Resend lo aceptó.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const client = getClient();
  if (!client) {
    console.warn(`[email] RESEND_API_KEY no definida — no se envió "${subject}" a ${to}`);
    return false;
  }

  try {
    const { error } = await client.emails.send({ from: env.RESEND_FROM_EMAIL, to, subject, html });
    if (error) {
      console.error("[email] Resend rechazó el envío:", error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[email] send failed:", error);
    return false;
  }
}

/** Plantilla base: tarjeta blanca centrada con encabezado de marca. */
export function layout(title: string, body: string): string {
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;font-family:Arial,Helvetica,sans-serif">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden">
        <tr><td style="background:#111;color:#fff;padding:20px 32px;font-size:18px;font-weight:bold">Lucas</td></tr>
        <tr><td style="padding:32px;color:#111;font-size:15px;line-height:1.6">
          <h1 style="margin:0 0 16px;font-size:22px">${title}</h1>
          ${body}
        </td></tr>
        <tr><td style="padding:16px 32px;color:#71717a;font-size:12px">© ${new Date().getFullYear()} Lucas</td></tr>
      </table>
    </td></tr>
  </table>`;
}
