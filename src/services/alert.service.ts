import { Types } from "mongoose";
import { Alert, AlertCategory, AlertLevel } from "../models/alert.model";
import { Operator } from "../models/operator.model";
import { TgInlineKeyboard } from "../types/telegram";
import { getSetting, setSetting } from "./setting.service";
import { escapeHtml, sendMessage } from "./telegram.service";

export const ALERT_CHAT_KEY = "alert_chat_id";

const ICONOS: Record<AlertCategory, string> = {
  mala_atencion: "🧑‍💼",
  sin_respuesta: "⏰",
  cliente_molesto: "😠",
  cliente_en_riesgo: "🚨",
  oportunidad: "💰",
  cobro: "💳",
  otro: "📌",
};

const TITULOS: Record<AlertCategory, string> = {
  mala_atencion: "Atención a revisar",
  sin_respuesta: "Cliente sin respuesta",
  cliente_molesto: "Cliente molesto",
  cliente_en_riesgo: "Cliente en riesgo de irse",
  oportunidad: "Oportunidad",
  cobro: "Cobro",
  otro: "Aviso",
};

// El mismo tipo de aviso del mismo cliente no se repite antes de esto.
const VENTANA_MS: Record<AlertLevel, number> = {
  aviso: 24 * 3_600_000,
  urgente: 6 * 3_600_000,
};

export async function setAlertChat(chatId: number, by: string): Promise<void> {
  await setSetting(ALERT_CHAT_KEY, String(chatId), by);
}

/**
 * A dónde van los avisos: el grupo del equipo registrado con /alertasaqui o,
 * si no hay grupo, el chat privado de cada operador vinculado.
 */
async function destinos(): Promise<number[]> {
  const grupo = Number(await getSetting(ALERT_CHAT_KEY));
  if (grupo) return [grupo];
  const operadores = await Operator.find({ isActive: true })
    .select("telegramChatId")
    .lean<{ telegramChatId: number }[]>();
  return operadores.map((o) => o.telegramChatId);
}

export async function describirDestino(): Promise<string> {
  const grupo = await getSetting(ALERT_CHAT_KEY);
  return grupo
    ? "al grupo del equipo registrado con /alertasaqui"
    : "al chat privado de cada operador (no hay grupo registrado; en un grupo escribe /alertasaqui código)";
}

/** Manda el aviso al equipo salvo que ya se haya mandado el mismo hace poco. */
export async function avisarEquipo(params: {
  clientId: Types.ObjectId | null;
  clientName?: string;
  category: AlertCategory;
  level: AlertLevel;
  text: string;
  dedupeKey?: string;
  keyboard?: TgInlineKeyboard;
}): Promise<boolean> {
  const filtro: Record<string, unknown> = { category: params.category, client: params.clientId };
  if (params.dedupeKey) filtro.dedupeKey = params.dedupeKey;
  else filtro.createdAt = { $gt: new Date(Date.now() - VENTANA_MS[params.level]) };

  const previa = await Alert.findOne(filtro).sort({ createdAt: -1 }).lean<{ level: string }>();
  // Un aviso que sube de "aviso" a "urgente" sí sale aunque haya uno reciente.
  if (previa && !(previa.level === "aviso" && params.level === "urgente")) return false;

  await Alert.create({
    client: params.clientId,
    category: params.category,
    level: params.level,
    text: params.text,
    dedupeKey: params.dedupeKey ?? "",
  });

  const html = [
    `${params.level === "urgente" ? "🔴" : "🟡"} ${ICONOS[params.category]} <b>${TITULOS[params.category]}</b>${
      params.clientName ? ` · ${escapeHtml(params.clientName)}` : ""
    }`,
    escapeHtml(params.text),
  ].join("\n");

  const keyboard =
    params.keyboard ??
    (params.clientId
      ? [[{ text: "💡 Qué le respondo", callback_data: `sug:${params.clientId}` }]]
      : undefined);

  for (const chatId of await destinos()) {
    await sendMessage(chatId, html, keyboard).catch((error) =>
      console.error("[alertas] no se pudo avisar a", chatId, error?.message ?? error),
    );
  }
  return true;
}
