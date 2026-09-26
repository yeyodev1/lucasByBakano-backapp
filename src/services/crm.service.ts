import { env } from "../config/env";
import { TgInlineKeyboard } from "../types/telegram";
import { estadoCrmEntornos } from "./metrics.service";
import { OperatorDoc } from "./operator.service";
import { escapeHtml, sendMessage, sendTyping } from "./telegram.service";

export function linkIntegraciones(workspaceId: string): string {
  return `${env.METRICS_APP_URL.replace(/\/$/, "")}/app/workspaces/${workspaceId}/integraciones`;
}

/**
 * /crm: qué clientes activos tienen su GoHighLevel conectado, cuáles no tienen
 * WhatsApp en el CRM y quiénes dejaron ir más leads esta semana.
 */
export async function resumenCrm(operator: OperatorDoc): Promise<void> {
  const chatId = operator.telegramChatId;
  if (!env.METRICS_DB_URI) {
    await sendMessage(chatId, "Para ver los CRM me falta configurar METRICS_DB_URI.");
    return;
  }
  await sendTyping(chatId);
  const entornos = await estadoCrmEntornos();

  const conectados = entornos.filter((e) => e.crm?.estado === "conectado");
  const conError = entornos.filter((e) => e.crm && e.crm.estado !== "conectado");
  const sinCrm = entornos.filter((e) => !e.crm);
  const sinWhatsapp = conectados.filter((e) => e.crm?.whatsapp === "no_detectado");
  const conLeads = entornos
    .filter((e) => e.hallazgosSemana > 0)
    .sort((a, b) => b.hallazgosSemana - a.hallazgosSemana);

  const nombres = (lista: typeof entornos, max = 12) =>
    lista
      .slice(0, max)
      .map((e) => escapeHtml(e.nombre))
      .join(", ") + (lista.length > max ? ` y ${lista.length - max} más` : "");

  const lines = [
    `🔌 <b>CRM de los clientes activos</b> (${entornos.length})`,
    "",
    `✅ Conectados: <b>${conectados.length}</b>`,
    conError.length
      ? `⚠️ Con error (reconectar): <b>${conError.length}</b> · ${nombres(conError)}`
      : "",
    sinWhatsapp.length
      ? `📵 Sin WhatsApp en el CRM: <b>${sinWhatsapp.length}</b> · ${nombres(sinWhatsapp)}`
      : "",
    `➖ Sin conectar: <b>${sinCrm.length}</b>${sinCrm.length ? ` · ${nombres(sinCrm)}` : ""}`,
  ].filter(Boolean);

  if (conLeads.length) {
    lines.push("", "🎯 <b>Leads que se les fueron esta semana</b>");
    for (const e of conLeads.slice(0, 10))
      lines.push(`• ${escapeHtml(e.nombre)}: ${e.hallazgosSemana}`);
  }
  lines.push(
    "",
    "<i>Cada cliente conecta su CRM en Metrics → Integraciones (o lo conectan ustedes por él). Toca uno para abrirlo.</i>",
  );

  const keyboard: TgInlineKeyboard = [...conError, ...sinCrm]
    .slice(0, 8)
    .map((e) => [{ text: `🔌 ${e.nombre.slice(0, 40)}`, url: linkIntegraciones(e.id) }]);

  await sendMessage(chatId, lines.join("\n"), keyboard);
}
