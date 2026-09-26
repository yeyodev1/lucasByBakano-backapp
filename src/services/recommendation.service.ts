import { Types } from "mongoose";
import { Suggestion } from "../models/suggestion.model";
import { TgInlineKeyboard } from "../types/telegram";
import * as aiService from "./ai.service";
import { applyCapturedData, ClientDoc, getClientById } from "./client.service";
import { countConversations, getContext, setConversationSummary } from "./conversation.service";
import { OperatorDoc } from "./operator.service";
import { CobroEntorno, cobroDeEntorno } from "./finances.service";
import { ContextoMetrics, contextoDeCliente } from "./metrics.service";
import { avisarEquipo } from "./alert.service";
import { linkIntegraciones } from "./crm.service";
import { BUSINESS_KEY, getSetting } from "./setting.service";
import { escapeHtml, sendMessage, sendTyping } from "./telegram.service";

const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  contactado: "Contactado",
  interesado: "Interesado",
  propuesta: "Propuesta enviada",
  negociacion: "Negociación",
  cliente: "Cliente",
  perdido: "Perdido",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

function haceCuanto(fecha: Date): string {
  const horas = Math.round((Date.now() - new Date(fecha).getTime()) / 3_600_000);
  if (horas < 1) return "hace un rato";
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.round(horas / 24);
  return `hace ${dias} día${dias === 1 ? "" : "s"}`;
}

/** Una línea con lo que dice Metrics: si ya es cliente de Bakano y en qué estado. */
export function metricsLine(metrics: ContextoMetrics): string {
  if (metrics.estado === "no_configurado") return "";
  if (metrics.estado === "error") return "⚪ <i>Metrics no respondió: no sé si ya es cliente.</i>";
  if (metrics.estado === "sin_entorno") return "⚪ Prospecto: no tiene entorno en Metrics";
  return metrics.entornos
    .map((e) => {
      const estado = e.activo
        ? "🟢 Entorno activo"
        : `🔴 Entorno inactivo${e.desactivacion ? ` (${escapeHtml(e.desactivacion)})` : ""}`;
      const duda =
        e.coincidencia === "nombre" ? " · <i>coincide solo por nombre, confirmar</i>" : "";
      const bot: string[] = [];
      if (e.bot.recordoPagoEn) bot.push(`le recordó el pago ${haceCuanto(e.bot.recordoPagoEn)}`);
      if (e.bot.alertoEquipoEn) {
        bot.push(
          `alertó al equipo (${escapeHtml(e.bot.alertaEstado)}) ${haceCuanto(e.bot.alertoEquipoEn)}`,
        );
      }
      const crm = !e.crm
        ? "\n🔌 <i>CRM sin conectar</i>"
        : e.crm.estado !== "conectado"
          ? "\n🔌 <i>CRM con error, hay que reconectarlo</i>"
          : `\n🔌 CRM conectado · WhatsApp ${
              e.crm.whatsapp === "conectado"
                ? "✅"
                : e.crm.whatsapp === "no_detectado"
                  ? "❌ no detectado"
                  : "❔"
            }`;
      const cierres = e.hallazgos.filter((h) => h.tipo === "cierre_casi_solo").length;
      const perdidos = cierres
        ? `\n🎯 <b>${cierres}</b> cierre${cierres === 1 ? "" : "s"} casi solo${cierres === 1 ? "" : "s"} sin cerrar esta semana`
        : "";
      return `${estado}: <b>${escapeHtml(e.nombre)}</b>${duda}${crm}${perdidos}${
        bot.length ? `\n🤖 <i>El bot de Bakano ${bot.join(" y ")}</i>` : ""
      }`;
    })
    .join("\n");
}

/** Saldo con Bakano de cada entorno encontrado en Metrics. */
export async function cobrosDeCliente(metrics: ContextoMetrics): Promise<CobroEntorno[]> {
  if (metrics.estado !== "encontrado") return [];
  const cobros = await Promise.all(metrics.entornos.slice(0, 3).map((e) => cobroDeEntorno(e.id)));
  return cobros.filter((c): c is CobroEntorno => c !== null);
}

/** Línea de cobro para la ficha y la recomendación. */
export function cobroLine(cobros: CobroEntorno[]): string {
  return cobros
    .filter((c) => c.saldoPendiente > 0)
    .map(
      (c) =>
        `💰 Debe <b>$${c.saldoPendiente.toFixed(2)}</b> (${c.facturas.length} factura${
          c.facturas.length === 1 ? "" : "s"
        }${c.vencidas ? `, ${c.vencidas} vencida${c.vencidas === 1 ? "" : "s"}` : ""})`,
    )
    .join("\n");
}

/** Botones para generar el link de pago de cada entorno con saldo. */
export function cobroKeyboard(cobros: CobroEntorno[]): TgInlineKeyboard {
  return cobros
    .filter((c) => c.saldoPendiente > 0 && c.stripeActivo)
    .map((c) => [
      {
        text:
          cobros.length > 1
            ? `💳 Link de pago · ${c.cliente.slice(0, 30)}`
            : "💳 Generar link de pago",
        callback_data: `pagar:${c.workspaceId}`,
      },
    ]);
}

/** Ficha corta del cliente para mostrar en Telegram. */
export async function clientCard(
  client: ClientDoc,
): Promise<{ html: string; keyboard: TgInlineKeyboard }> {
  const [total, metrics] = await Promise.all([
    countConversations(client._id),
    contextoDeCliente(client),
  ]);
  const cobros = await cobrosDeCliente(metrics);
  const lines = [
    `👤 <b>${escapeHtml(client.name)}</b>${client.company ? ` · ${escapeHtml(client.company)}` : ""}`,
    `Etapa: <b>${stageLabel(client.stage)}</b> · ${total} conversación${total === 1 ? "" : "es"}`,
  ];
  const enMetrics = metricsLine(metrics);
  if (enMetrics) lines.push(enMetrics);
  const deuda = cobroLine(cobros);
  if (deuda) lines.push(deuda);
  if (client.phones.length) lines.push(`📱 ${client.phones.map(escapeHtml).join(", ")}`);
  if (client.email) lines.push(`✉️ ${escapeHtml(client.email)}`);
  if (client.telegramUsername) lines.push(`💬 @${escapeHtml(client.telegramUsername)}`);
  if (client.interests.length) lines.push(`🎯 ${client.interests.map(escapeHtml).join(", ")}`);
  if (client.summary) lines.push("", `<i>${escapeHtml(client.summary)}</i>`);
  const notes = client.notes.slice(-3);
  if (notes.length) {
    lines.push("", "<b>Últimas notas</b>");
    for (const n of notes) lines.push(`• ${escapeHtml(n.text)}`);
  }
  return {
    html: lines.join("\n"),
    keyboard: [
      [{ text: "💡 Sugerir respuesta", callback_data: `sug:${client._id}` }],
      ...cobroKeyboard(cobros),
      ...(metrics.estado === "encontrado"
        ? metrics.entornos
            .filter((e) => !e.crm || e.crm.estado !== "conectado")
            .slice(0, 2)
            .map((e) => [
              { text: `🔌 Conectar CRM · ${e.nombre.slice(0, 30)}`, url: linkIntegraciones(e.id) },
            ])
        : []),
    ],
  };
}

/**
 * Genera la recomendación, actualiza el CRM con lo capturado y se la manda
 * al operador. contextOverride permite /sugerir 0 o /sugerir 5 sin cambiar
 * la preferencia guardada.
 */
export async function recommendForClient(params: {
  operator: OperatorDoc;
  clientId: Types.ObjectId;
  instruction?: string;
  contextOverride?: number;
  prefix?: string;
}): Promise<void> {
  const { operator } = params;
  const chatId = operator.telegramChatId;
  await sendTyping(chatId);

  const contextCount = params.contextOverride ?? operator.contextConversations;
  const [client, business, context] = await Promise.all([
    getClientById(params.clientId),
    getSetting(BUSINESS_KEY),
    getContext(params.clientId, contextCount),
  ]);
  const [totalConversations, metrics] = await Promise.all([
    countConversations(client._id),
    contextoDeCliente(client),
  ]);
  const cobros = await cobrosDeCliente(metrics);

  const { data, usage } = await aiService.recommendReply({
    business,
    client,
    totalConversations,
    current: context.current,
    previous: context.previous,
    metrics,
    cobros,
    instruction: params.instruction,
  });

  const changes = await applyCapturedData(
    client._id,
    {
      phone: data.captured.phone,
      email: data.captured.email,
      company: data.captured.company,
      interests: data.captured.interests,
    },
    { summary: data.summary, stage: data.suggestedStage },
  );
  if (context.current) await setConversationSummary(context.current.conversation._id, data.summary);

  const suggestion = await Suggestion.create({
    client: client._id,
    conversation: context.current?.conversation._id ?? null,
    operator: operator._id,
    contextConversations: context.previous.length,
    clientIntent: data.clientIntent,
    summary: data.summary,
    replies: data.replies,
    nextStep: data.nextStep,
    alerts: data.alerts,
    suggestedStage: data.suggestedStage,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  const read =
    context.previous.length === 0
      ? "solo la conversación actual"
      : `la actual + ${context.previous.length} anterior${context.previous.length === 1 ? "" : "es"}`;

  const lines: string[] = [];
  if (params.prefix) lines.push(params.prefix, "");
  lines.push(`🧠 <b>${escapeHtml(client.name)}</b> · ${stageLabel(client.stage)}`);
  const enMetrics = metricsLine(metrics);
  if (enMetrics) lines.push(enMetrics);
  const deuda = cobroLine(cobros);
  if (deuda) lines.push(deuda);
  lines.push(
    `<i>Leí ${read} (de ${totalConversations}).</i>`,
    "",
    `<b>Qué quiere:</b> ${escapeHtml(data.clientIntent)}`,
    `<b>Situación:</b> ${escapeHtml(data.summary)}`,
  );
  if (data.nextStep) lines.push("", `➡️ <b>Siguiente paso:</b> ${escapeHtml(data.nextStep)}`);
  if (data.alerts.length) {
    lines.push("", "⚠️ <b>Ojo</b>");
    for (const alert of data.alerts) lines.push(`• ${escapeHtml(alert)}`);
  }
  if (changes.length) {
    lines.push("", `📝 <i>CRM actualizado: ${escapeHtml(changes.join(", "))}</i>`);
  }
  if (data.teamAlert.level !== "ninguna" && data.teamAlert.message) {
    const enviado = await avisarEquipo({
      clientId: client._id,
      clientName: client.name,
      category: data.teamAlert.category,
      level: data.teamAlert.level,
      text: `${data.teamAlert.message}\n\n(Detectado al revisar el chat con ${operator.name || "un asesor"}.)`,
    });
    lines.push(
      "",
      enviado
        ? `📣 <i>Avisé al equipo: ${escapeHtml(data.teamAlert.message)}</i>`
        : `📣 <i>El equipo ya estaba avisado de esto.</i>`,
    );
  }
  await sendMessage(chatId, lines.join("\n"), cobroKeyboard(cobros));

  // Cada opción en su propio mensaje: se copia con un toque o se reenvía tal cual.
  for (let i = 0; i < data.replies.length; i++) {
    const reply = data.replies[i];
    const isLast = i === data.replies.length - 1;
    const keyboard: TgInlineKeyboard = [
      [{ text: `✅ Usé esta`, callback_data: `usar:${suggestion._id}:${i}` }],
    ];
    if (isLast) keyboard.push([{ text: "🔁 Otras opciones", callback_data: `sug:${client._id}` }]);
    await sendMessage(
      chatId,
      `💬 <b>${i + 1} · ${escapeHtml(reply.tone)}</b>\n<code>${escapeHtml(reply.text)}</code>`,
      keyboard,
    );
  }
}

export async function markChosen(suggestionId: string, index: number): Promise<boolean> {
  if (!Types.ObjectId.isValid(suggestionId)) return false;
  const result = await Suggestion.updateOne(
    { _id: suggestionId },
    { $set: { chosenReply: index } },
  );
  return result.matchedCount > 0;
}
