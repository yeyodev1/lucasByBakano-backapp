import axios from "axios";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { TgInlineKeyboard, TgMessage, TgUpdate } from "../types/telegram";

// Telegram corta en 4096 caracteres; se deja margen para las etiquetas HTML.
const MAX_MESSAGE_LENGTH = 3900;

export const ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "business_connection",
  "business_message",
];

export const BOT_COMMANDS = [
  { command: "ventas", description: "Cómo va tu mes de ventas" },
  { command: "calientes", description: "Los clientes más cerca de comprar" },
  { command: "cliente", description: "Buscar y elegir cliente: /cliente María" },
  { command: "sugerir", description: "Qué responder: /sugerir [n] [pedido]" },
  { command: "ficha", description: "Ver la ficha del cliente activo" },
  { command: "nuevo", description: "Crear cliente: /nuevo María | 0991234567" },
  { command: "negocio", description: "Qué vendes, precios y condiciones" },
  { command: "pago", description: "Tus datos de pago" },
  { command: "regla", description: "Una regla que siempre respeto" },
  { command: "reglas", description: "Ver y quitar reglas" },
  { command: "nota", description: "Nota en la ficha del cliente" },
  { command: "etapa", description: "Cambiar la etapa del cliente" },
  { command: "contexto", description: "Conversaciones anteriores a leer" },
  { command: "alertas", description: "Cuándo y dónde te aviso" },
  { command: "soltar", description: "Dejar el cliente activo" },
  { command: "ayuda", description: "Cómo usar a Lucas" },
];

function apiUrl(method: string): string {
  if (!env.TELEGRAM_BOT_TOKEN) throw new CustomError("Falta TELEGRAM_BOT_TOKEN", 500);
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

export async function callTelegram<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<T> {
  try {
    const { data } = await axios.post(apiUrl(method), params, { timeout: timeoutMs });
    return data.result as T;
  } catch (error: any) {
    const description = error?.response?.data?.description ?? error?.message ?? "error";
    // El token viaja en la URL: nunca se propaga el error crudo de axios.
    throw new CustomError(`Telegram ${method}: ${description}`, 502);
  }
}

/** Escapa texto para parse_mode HTML. Todo dato de cliente pasa por aquí. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  let current = "";
  // Se corta por párrafos para no partir una etiqueta HTML a la mitad.
  for (const block of text.split("\n\n")) {
    if ((current + "\n\n" + block).length > MAX_MESSAGE_LENGTH && current) {
      parts.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export async function sendMessage(
  chatId: number,
  html: string,
  keyboard?: TgInlineKeyboard,
): Promise<TgMessage | null> {
  const parts = splitMessage(html);
  let last: TgMessage | null = null;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    last = await callTelegram<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: parts[i],
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(isLast && keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }
  return last;
}

export async function sendTyping(chatId: number): Promise<void> {
  await callTelegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await callTelegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text } : {}),
  }).catch(() => {});
}

export async function removeKeyboard(chatId: number, messageId: number): Promise<void> {
  await callTelegram("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

/** Descarga un archivo del chat (capturas) y lo devuelve en memoria. */
export async function downloadFile(fileId: string): Promise<{ data: Buffer; path: string }> {
  const file = await callTelegram<{ file_path?: string; file_size?: number }>("getFile", {
    file_id: fileId,
  });
  if (!file.file_path) throw new CustomError("Telegram no devolvió el archivo", 502);
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  try {
    const { data } = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 30000,
    });
    return { data: Buffer.from(data), path: file.file_path };
  } catch {
    throw new CustomError("No se pudo descargar el archivo de Telegram", 502);
  }
}

export async function setWebhook(url: string): Promise<void> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new CustomError("Falta TELEGRAM_WEBHOOK_SECRET", 500);
  await callTelegram("setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
  });
  await callTelegram("setMyCommands", { commands: BOT_COMMANDS });
}

export async function deleteWebhook(): Promise<void> {
  await callTelegram("deleteWebhook", { drop_pending_updates: false });
}

export async function getUpdates(offset: number): Promise<TgUpdate[]> {
  return callTelegram<TgUpdate[]>(
    "getUpdates",
    { offset, timeout: 50, allowed_updates: ALLOWED_UPDATES },
    60000,
  );
}
