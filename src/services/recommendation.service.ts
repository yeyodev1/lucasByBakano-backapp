import { Types } from "mongoose";
import { Suggestion } from "../models/suggestion.model";
import { TgInlineKeyboard } from "../types/telegram";
import * as aiService from "./ai.service";
import { avisarEquipo } from "./alert.service";
import { applyCapturedData, ClientDoc, getClientById } from "./client.service";
import { countConversations, getContext, setConversationSummary } from "./conversation.service";
import { contextoDeNegocio } from "./negocio.service";
import { crmDelLead } from "./metrics.service";
import { OperatorDoc } from "./operator.service";
import { escapeHtml, sendMessage, sendTyping } from "./telegram.service";

const STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  contactado: "Contactado",
  interesado: "Interesado",
  propuesta: "Propuesta enviada",
  negociacion: "Negociación",
  cliente: "Compró",
  perdido: "Perdido",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

const TEMPERATURA: Record<string, string> = {
  frio: "🧊 Frío",
  tibio: "🌤️ Tibio",
  caliente: "🔥 Caliente",
  listo_para_pagar: "💰 Listo para pagar",
};

export function temperaturaLabel(temperatura: string): string {
  return TEMPERATURA[temperatura] ?? "";
}

/** Barra de 10 bloques: se lee de un vistazo en el celular. */
export function barraCierre(probabilidad: number): string {
  const llenos = Math.round(Math.max(0, Math.min(100, probabilidad)) / 10);
  return `${"▰".repeat(llenos)}${"▱".repeat(10 - llenos)} ${probabilidad}%`;
}

/** Ficha corta del lead para mostrar en Telegram. */
export async function clientCard(
  client: ClientDoc,
): Promise<{ html: string; keyboard: TgInlineKeyboard }> {
  const total = await countConversations(client._id);
  const lines = [
    `👤 <b>${escapeHtml(client.name)}</b>${client.company ? ` · ${escapeHtml(client.company)}` : ""}`,
    `Etapa: <b>${stageLabel(client.stage)}</b> · ${total} conversación${total === 1 ? "" : "es"}`,
  ];
  if (client.cierre?.en) {
    lines.push(
      `${temperaturaLabel(client.cierre.temperatura)} · ${barraCierre(client.cierre.probabilidad)}`,
    );
    if (client.cierre.falta?.length) {
      lines.push(`<i>Falta: ${escapeHtml(client.cierre.falta.join(", "))}</i>`);
    }
  }
  if (client.phones.length) lines.push(`📱 ${client.phones.map(escapeHtml).join(", ")}`);
  if (client.email) lines.push(`✉️ ${escapeHtml(client.email)}`);
  if (client.interests.length) lines.push(`🎯 ${client.interests.map(escapeHtml).join(", ")}`);
  if (client.summary) lines.push("", `<i>${escapeHtml(client.summary)}</i>`);
  const notes = client.notes.slice(-3);
  if (notes.length) {
    lines.push("", "<b>Últimas notas</b>");
    for (const n of notes) lines.push(`• ${escapeHtml(n.text)}`);
  }
  return {
    html: lines.join("\n"),
    keyboard: [[{ text: "💡 Qué le respondo", callback_data: `sug:${client._id}` }]],
  };
}

/**
 * Genera la recomendación para cerrar la venta, actualiza la ficha del lead
 * y se la manda a quien vende. contextOverride permite /sugerir 0 o
 * /sugerir 5 sin cambiar la preferencia guardada.
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
  const [client, negocio, context] = await Promise.all([
    getClientById(params.clientId, operator.negocio),
    contextoDeNegocio(operator.negocio),
    getContext(params.clientId, contextCount),
  ]);
  // Lo que el CRM del negocio sabe de este lead (su venta, su asesor y los
  // últimos mensajes). Con tope: si Metrics tarda, se recomienda igual.
  const telefono = client.phones?.[0];
  const [totalConversations, crm] = await Promise.all([
    countConversations(client._id),
    negocio.negocio.workspaceId && telefono
      ? Promise.race([
          crmDelLead(String(negocio.negocio.workspaceId), telefono),
          new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
        ]).catch(() => null)
      : Promise.resolve(null),
  ]);

  const { data, usage } = await aiService.recommendReply({
    negocio,
    client,
    totalConversations,
    current: context.current,
    previous: context.previous,
    instruction: params.instruction,
    crm,
  });

  const changes = await applyCapturedData(
    client._id,
    {
      phone: data.captured.phone,
      email: data.captured.email,
      company: data.captured.company,
      interests: data.captured.interests,
    },
    {
      summary: data.summary,
      stage: data.suggestedStage,
      cierre: {
        probabilidad: data.cierre.probabilidad,
        temperatura: data.cierre.temperatura,
        falta: data.cierre.falta,
      },
    },
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
    `<b>${temperaturaLabel(data.cierre.temperatura)}</b>  ${barraCierre(data.cierre.probabilidad)}`,
    `<i>${escapeHtml(data.cierre.porQue)}</i>`,
  );
  if (data.cierre.falta.length) {
    lines.push(`<b>Falta para cerrar:</b> ${escapeHtml(data.cierre.falta.join(", "))}`);
  }
  lines.push(
    "",
    `<b>Qué quiere:</b> ${escapeHtml(data.clientIntent)}`,
    `<b>Situación:</b> ${escapeHtml(data.summary)}`,
  );
  lines.push(
    "",
    data.pago.enviarAhora
      ? `💳 <b>Es momento de mandarle el pago.</b> ${escapeHtml(data.pago.porQue)}`
      : `⏳ <b>Todavía no mandes el pago.</b> ${escapeHtml(data.pago.porQue)}`,
  );
  if (data.nextStep) lines.push("", `➡️ <b>Siguiente paso:</b> ${escapeHtml(data.nextStep)}`);
  if (data.alerts.length) {
    lines.push("", "⚠️ <b>Ojo</b>");
    for (const alert of data.alerts) lines.push(`• ${escapeHtml(alert)}`);
  }
  if (changes.length) {
    lines.push("", `📝 <i>Ficha actualizada: ${escapeHtml(changes.join(", "))}</i>`);
  }
  if (data.teamAlert.level !== "ninguna" && data.teamAlert.message && operator.negocio) {
    const enviado = await avisarEquipo({
      negocioId: operator.negocio,
      clientId: client._id,
      clientName: client.name,
      category: data.teamAlert.category,
      level: data.teamAlert.level,
      text: `${data.teamAlert.message}\n\n(Visto en el chat que atiende ${operator.name || "un vendedor"}.)`,
    });
    if (enviado)
      lines.push("", `📣 <i>Le avisé al dueño: ${escapeHtml(data.teamAlert.message)}</i>`);
  }
  await sendMessage(chatId, lines.join("\n"));

  // Cada opción en su propio mensaje: se copia con un toque o se reenvía tal cual.
  const mensajes = data.replies.map((reply, i) => ({
    titulo: `💬 <b>${i + 1} · ${escapeHtml(reply.tone)}</b>`,
    texto: reply.text,
    callback: `usar:${suggestion._id}:${i}`,
  }));
  if (data.pago.enviarAhora && data.pago.mensaje) {
    mensajes.push({
      titulo: "💳 <b>Mensaje de pago</b>",
      texto: data.pago.mensaje,
      callback: `usar:${suggestion._id}:pago`,
    });
  }
  for (let i = 0; i < mensajes.length; i++) {
    const m = mensajes[i];
    const keyboard: TgInlineKeyboard = [[{ text: "✅ Usé esta", callback_data: m.callback }]];
    if (i === mensajes.length - 1) {
      keyboard.push([{ text: "🔁 Otras opciones", callback_data: `sug:${client._id}` }]);
    }
    await sendMessage(chatId, `${m.titulo}\n<code>${escapeHtml(m.texto)}</code>`, keyboard);
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
