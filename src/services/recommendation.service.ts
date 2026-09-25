import { Types } from "mongoose";
import { Suggestion } from "../models/suggestion.model";
import { TgInlineKeyboard } from "../types/telegram";
import * as aiService from "./ai.service";
import { applyCapturedData, ClientDoc, getClientById } from "./client.service";
import { countConversations, getContext, setConversationSummary } from "./conversation.service";
import { OperatorDoc } from "./operator.service";
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

/** Ficha corta del cliente para mostrar en Telegram. */
export async function clientCard(client: ClientDoc): Promise<string> {
  const total = await countConversations(client._id);
  const lines = [
    `👤 <b>${escapeHtml(client.name)}</b>${client.company ? ` · ${escapeHtml(client.company)}` : ""}`,
    `Etapa: <b>${stageLabel(client.stage)}</b> · ${total} conversación${total === 1 ? "" : "es"}`,
  ];
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
  return lines.join("\n");
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
  const totalConversations = await countConversations(client._id);

  const { data, usage } = await aiService.recommendReply({
    business,
    client,
    totalConversations,
    current: context.current,
    previous: context.previous,
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
  lines.push(
    `🧠 <b>${escapeHtml(client.name)}</b> · ${stageLabel(client.stage)}`,
    `<i>Leí ${read} (de ${totalConversations}).</i>`,
    "",
    `<b>Qué quiere:</b> ${escapeHtml(data.clientIntent)}`,
    `<b>Situación:</b> ${escapeHtml(data.summary)}`,
  );
  data.replies.forEach((reply, i) => {
    lines.push(
      "",
      `💬 <b>Opción ${i + 1} · ${escapeHtml(reply.tone)}</b>`,
      `<code>${escapeHtml(reply.text)}</code>`,
    );
  });
  if (data.nextStep) lines.push("", `➡️ <b>Siguiente paso:</b> ${escapeHtml(data.nextStep)}`);
  if (data.alerts.length) {
    lines.push("", "⚠️ <b>Ojo</b>");
    for (const alert of data.alerts) lines.push(`• ${escapeHtml(alert)}`);
  }
  if (changes.length)
    lines.push("", `📝 <i>CRM actualizado: ${escapeHtml(changes.join(", "))}</i>`);
  lines.push("", "<i>Toca un texto para copiarlo.</i>");

  const keyboard: TgInlineKeyboard = [
    data.replies.map((_, i) => ({
      text: `✅ Usé la ${i + 1}`,
      callback_data: `usar:${suggestion._id}:${i}`,
    })),
    [{ text: "🔁 Otras opciones", callback_data: `sug:${client._id}` }],
  ];

  await sendMessage(chatId, lines.join("\n"), keyboard);
}

export async function markChosen(suggestionId: string, index: number): Promise<boolean> {
  if (!Types.ObjectId.isValid(suggestionId)) return false;
  const result = await Suggestion.updateOne(
    { _id: suggestionId },
    { $set: { chosenReply: index } },
  );
  return result.matchedCount > 0;
}
