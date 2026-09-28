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

// Colores de la marca Bakano (logo: negro, blanco y el punto rosado).
const NEGRO = "#0b0815";
const ROSADO = "#E5245E";
const GRIS = "#6b6478";

/**
 * Plantilla base con la marca Bakano: encabezado oscuro con Lucas, cuerpo
 * blanco y cierre con su firma. Tablas y estilos en línea porque Gmail y
 * Outlook ignoran casi todo el CSS de <style>.
 */
export function layout(title: string, body: string): string {
  const assets = `${env.PUBLIC_URL.replace(/\/$/, "")}/email`;
  return `
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f3f1f6;padding:32px 12px;font-family:'Helvetica Neue',Arial,Helvetica,sans-serif">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden">
        <tr><td style="background:${NEGRO};padding:28px 32px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr>
            <td width="64" valign="middle"><img src="${assets}/lucas.jpg" width="56" height="56" alt="Lucas" style="display:block;border-radius:50%;border:2px solid ${ROSADO}"></td>
            <td valign="middle" style="padding-left:14px">
              <div style="color:#ffffff;font-size:18px;font-weight:bold;line-height:1.2">Lucas</div>
              <div style="color:#c9c3d4;font-size:13px;line-height:1.4">Tu agente de ventas de Bakano</div>
            </td>
            <td width="40" align="right" valign="middle"><img src="${assets}/bakano.png" width="36" height="36" alt="Bakano" style="display:block"></td>
          </tr></table>
        </td></tr>
        <tr><td style="height:4px;background:${ROSADO};line-height:4px;font-size:0">&nbsp;</td></tr>
        <tr><td style="padding:32px;color:${NEGRO};font-size:15px;line-height:1.6">
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${NEGRO}">${title}</h1>
          ${body}
          <p style="margin:28px 0 0">Un abrazo,<br><b>Lucas</b> <span style="color:${GRIS}">· tu agente de ventas de Bakano</span></p>
        </td></tr>
        <tr><td style="padding:20px 32px;background:#faf9fb;border-top:1px solid #eeeaf2;color:${GRIS};font-size:12px;line-height:1.5">
          Estoy contigo todos los días y me acuerdo de cada cliente, cada conversación y cada regla de tu negocio. Escríbeme cuando quieras en <a href="https://t.me/LucasByBakanoBot" style="color:${ROSADO};text-decoration:none;font-weight:bold">Telegram</a>.<br>
          <span style="color:#a39cae">© ${new Date().getFullYear()} Bakano · bakano.ec</span>
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

/** El código de 6 dígitos grande y separado, fácil de leer y de copiar. */
export function codeBlock(codigo: string): string {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:20px 0"><tr>
    <td style="background:#fdf0f4;border:1px solid #f7c6d5;border-radius:14px;padding:16px 28px;font-size:32px;font-weight:bold;letter-spacing:8px;color:${NEGRO};font-family:'SF Mono',Menlo,Consolas,monospace">${codigo}</td>
  </tr></table>`;
}
