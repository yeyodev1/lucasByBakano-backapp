import { Types } from "mongoose";
import { Alert, AlertCategory, AlertLevel } from "../models/alert.model";
import { Operator } from "../models/operator.model";
import { TgInlineKeyboard } from "../types/telegram";
import { actualizarNegocio, getNegocio } from "./negocio.service";
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

/**
 * Grupo del negocio (registrado por su dueño con /alertasaqui) o, para el
 * equipo de Bakano (negocioId null), el grupo interno de Bakano.
 */
export async function setAlertChat(
  negocioId: Types.ObjectId | null,
  chatId: number,
  by: string,
): Promise<void> {
  if (negocioId) await actualizarNegocio(negocioId, { alertChatId: chatId });
  else await setSetting(ALERT_CHAT_KEY, String(chatId), by);
}

/**
 * A dónde van los avisos de un negocio: su grupo o, si no tiene, el chat del
 * dueño (y si no hay dueño vinculado, de todos sus vendedores). Los avisos
 * sin negocio son del equipo de Bakano.
 */
async function destinos(negocioId: Types.ObjectId | null): Promise<number[]> {
  if (!negocioId) {
    const grupo = Number(await getSetting(ALERT_CHAT_KEY));
    if (grupo) return [grupo];
    const bakano = await Operator.find({ isActive: true, role: "bakano" })
      .select("telegramChatId")
      .lean<{ telegramChatId: number }[]>();
    return bakano.map((o) => o.telegramChatId);
  }
  const negocio = await getNegocio(negocioId);
  if (negocio?.alertChatId) return [negocio.alertChatId];
  const operadores = await Operator.find({
    isActive: true,
    negocio: negocioId,
    role: { $ne: "bakano" },
  })
    .select("telegramChatId role")
    .lean<{ telegramChatId: number; role: string }[]>();
  const duenos = operadores.filter((o) => o.role === "dueno");
  return (duenos.length ? duenos : operadores).map((o) => o.telegramChatId);
}

export async function describirDestino(negocioId: Types.ObjectId | null): Promise<string> {
  const negocio = negocioId ? await getNegocio(negocioId) : null;
  if (negocio?.alertChatId) return "al grupo de tu negocio registrado con /alertasaqui";
  if (negocioId) {
    return "a tu chat privado (si eres el dueño). Para que lleguen a un grupo de tu equipo, agrégame al grupo y escribe ahí /alertasaqui";
  }
  return (await getSetting(ALERT_CHAT_KEY))
    ? "al grupo interno de Bakano"
    : "al chat privado del equipo de Bakano";
}

/** Manda el aviso al equipo salvo que ya se haya mandado el mismo hace poco. */
export async function avisarEquipo(params: {
  negocioId: Types.ObjectId | null;
  clientId: Types.ObjectId | null;
  clientName?: string;
  category: AlertCategory;
  level: AlertLevel;
  text: string;
  dedupeKey?: string;
  keyboard?: TgInlineKeyboard;
}): Promise<boolean> {
  const filtro: Record<string, unknown> = {
    category: params.category,
    client: params.clientId,
    negocio: params.negocioId,
  };
  if (params.dedupeKey) filtro.dedupeKey = params.dedupeKey;
  else filtro.createdAt = { $gt: new Date(Date.now() - VENTANA_MS[params.level]) };

  const previa = await Alert.findOne(filtro).sort({ createdAt: -1 }).lean<{ level: string }>();
  // Un aviso que sube de "aviso" a "urgente" sí sale aunque haya uno reciente.
  if (previa && !(previa.level === "aviso" && params.level === "urgente")) return false;

  await Alert.create({
    negocio: params.negocioId,
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

  for (const chatId of await destinos(params.negocioId)) {
    await sendMessage(chatId, html, keyboard).catch((error) =>
      console.error("[alertas] no se pudo avisar a", chatId, error?.message ?? error),
    );
  }
  return true;
}
