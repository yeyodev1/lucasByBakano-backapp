import { Types } from "mongoose";
import { Message } from "../models/message.model";
import { TgInlineKeyboard, TgMessage } from "../types/telegram";
import * as aiService from "./ai.service";
import { ClientDoc, ClientIdentity, getClientById, resolveClient } from "./client.service";
import { avisarEquipo } from "./alert.service";
import { appendMessages, getContext, IncomingMessage } from "./conversation.service";
import { OperatorDoc, updateOperator } from "./operator.service";
import { recommendForClient } from "./recommendation.service";
import { downloadFile, escapeHtml, sendMessage, sendTyping } from "./telegram.service";

/**
 * Captura esperando cliente: se guarda en el operador mientras elige a quién
 * pertenece, para no tener que volver a mandar la foto.
 */
interface PendingCapture {
  kind: "capture";
  channel: "captura" | "texto";
  messages: IncomingMessage[];
  instruction: string;
  name: string;
}

export function readPendingCapture(operator: OperatorDoc): PendingCapture | null {
  if (!operator.pendingAction) return null;
  try {
    const parsed = JSON.parse(operator.pendingAction);
    return parsed?.kind === "capture" ? (parsed as PendingCapture) : null;
  } catch {
    return null;
  }
}

function mediaTypeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

function clientKeyboard(clients: ClientDoc[], action: string): TgInlineKeyboard {
  return clients.map((c) => [
    {
      text: `${c.name}${c.company ? ` · ${c.company}` : ""}${c.phones[0] ? ` · …${c.phones[0].slice(-4)}` : ""}`,
      callback_data: `${action}:${c._id}`,
    },
  ]);
}

/**
 * Captura de pantalla o conversación pegada: la IA la transcribe, se ubica al
 * cliente (o se crea), se guarda en el historial y se recomienda qué decir.
 */
export async function handleCapture(
  operator: OperatorDoc,
  message: TgMessage,
  pastedText?: string,
): Promise<void> {
  const chatId = operator.telegramChatId;
  await sendTyping(chatId);

  const images: aiService.CaptureInput["images"] = [];
  const photo = message.photo?.at(-1);
  const imageDocument = message.document?.mime_type?.startsWith("image/") ? message.document : null;
  const fileId = photo?.file_id ?? imageDocument?.file_id;
  if (fileId) {
    const file = await downloadFile(fileId);
    images.push({ data: file.data, mediaType: mediaTypeFromPath(file.path) });
  }

  const { data } = await aiService.extractConversation({
    images,
    text: pastedText,
    hint: message.caption,
    operatorName: operator.name,
  });

  const instruction = data.operatorInstruction?.trim() ?? "";

  // Sin conversación: el operador está preguntando algo del cliente activo.
  if (!data.isConversation || !data.messages.length) {
    if (!operator.activeClientId) {
      await sendMessage(
        chatId,
        "No encontré una conversación ahí. Mándame una captura del chat, pégalo como texto, o elige un cliente con /cliente <nombre> y pregúntame.",
      );
      return;
    }
    await recommendForClient({
      operator,
      clientId: operator.activeClientId,
      instruction: instruction || pastedText,
    });
    return;
  }

  const messages: IncomingMessage[] = data.messages.map((m) => ({
    sender: m.sender,
    senderName: m.senderName,
    text: m.text,
  }));

  const identity: ClientIdentity = {
    name: data.client.name,
    phone: data.client.phone,
    email: data.client.email,
    telegramUsername: data.client.username,
  };
  const hasIdentity = Boolean(
    identity.name || identity.phone || identity.email || identity.telegramUsername,
  );

  let client: ClientDoc | null = null;
  let created = false;

  if (hasIdentity) {
    const result = await resolveClient(identity, { createIfMissing: false });
    client = result.client;
    if (!client && result.candidates.length) {
      await askForClient(
        operator,
        {
          messages,
          instruction,
          name: identity.name ?? "",
          channel: pastedText ? "texto" : "captura",
        },
        result.candidates,
      );
      return;
    }
  }
  // La captura no dice de quién es: se usa el cliente con el que se está trabajando.
  if (!client && operator.activeClientId && !identity.name) {
    client = await getClientById(operator.activeClientId);
  }
  if (!client && identity.name) {
    const result = await resolveClient(identity, { createIfMissing: true, source: data.platform });
    client = result.client;
    created = result.created;
  }
  if (!client) {
    await askForClient(
      operator,
      { messages, instruction, name: "", channel: pastedText ? "texto" : "captura" },
      [],
    );
    return;
  }

  await saveAndRecommend(operator, client, {
    messages,
    instruction,
    channel: pastedText ? "texto" : "captura",
    prefix: `${created ? "🆕 Cliente nuevo en el CRM" : "📥 Guardado en el historial de"} <b>${escapeHtml(client.name)}</b> (${data.messages.length} mensajes${data.platform ? ` de ${escapeHtml(data.platform)}` : ""}).`,
  });
}

async function askForClient(
  operator: OperatorDoc,
  pending: Omit<PendingCapture, "kind">,
  candidates: ClientDoc[],
): Promise<void> {
  await updateOperator(operator._id, {
    pendingAction: JSON.stringify({ kind: "capture", ...pending }),
  });
  const keyboard = clientKeyboard(candidates, "cap");
  if (pending.name)
    keyboard.push([{ text: `➕ Crear "${pending.name}"`, callback_data: "capnew" }]);
  const text = candidates.length
    ? `Hay varios clientes que se llaman así. De cuál es esta conversación?`
    : `Leí ${pending.messages.length} mensajes pero no sé de qué cliente son. Respóndeme con /cliente <nombre o teléfono> o créalo con /nuevo <nombre> y la guardo ahí.`;
  await sendMessage(operator.telegramChatId, text, keyboard);
}

/** Aplica la captura pendiente al cliente que eligió el operador. */
export async function resolvePendingCapture(
  operator: OperatorDoc,
  clientId: Types.ObjectId | null,
): Promise<boolean> {
  const pending = readPendingCapture(operator);
  if (!pending) return false;
  await updateOperator(operator._id, { pendingAction: "" });

  let client: ClientDoc | null = null;
  if (clientId) client = await getClientById(clientId);
  else if (pending.name)
    client = (await resolveClient({ name: pending.name }, { createIfMissing: true })).client;
  if (!client) return false;

  await saveAndRecommend(operator, client, {
    messages: pending.messages,
    instruction: pending.instruction,
    channel: pending.channel,
    prefix: `📥 Guardado en el historial de <b>${escapeHtml(client.name)}</b>.`,
  });
  return true;
}

async function saveAndRecommend(
  operator: OperatorDoc,
  client: ClientDoc,
  params: {
    messages: IncomingMessage[];
    instruction: string;
    channel: "captura" | "texto";
    prefix: string;
  },
): Promise<void> {
  await appendMessages({
    clientId: client._id,
    operatorId: operator._id,
    channel: params.channel,
    messages: params.messages,
  });
  await updateOperator(operator._id, { activeClientId: client._id });
  await recommendForClient({
    operator,
    clientId: client._id,
    instruction: params.instruction,
    prefix: params.prefix,
  });
}

/**
 * Mensaje reenviado desde un chat de Telegram. Se guarda sin llamar a la IA:
 * suelen llegar en ráfaga y el operador pide /sugerir cuando termina.
 */
export async function handleForward(operator: OperatorDoc, message: TgMessage): Promise<void> {
  const origin = message.forward_origin!;
  const text = message.text ?? message.caption ?? "";
  if (!text) {
    await sendMessage(
      operator.telegramChatId,
      "Por ahora solo guardo reenvíos con texto. Si es una foto, mándamela como captura.",
    );
    return;
  }

  let identity: ClientIdentity = {};
  let senderName = "";
  if (origin.type === "user") {
    // Si reenvía un mensaje suyo, es del equipo y el cliente es el activo.
    if (origin.sender_user.id === operator.telegramUserId) {
      if (!operator.activeClientId) {
        await sendMessage(
          operator.telegramChatId,
          "Ese mensaje es tuyo. Elige primero el cliente con /cliente <nombre>.",
        );
        return;
      }
      await appendMessages({
        clientId: operator.activeClientId,
        operatorId: operator._id,
        channel: "reenvio",
        messages: [
          {
            sender: "equipo",
            senderName: operator.name,
            text,
            sentAt: new Date(origin.date * 1000),
          },
        ],
      });
      return;
    }
    senderName = [origin.sender_user.first_name, origin.sender_user.last_name]
      .filter(Boolean)
      .join(" ");
    identity = {
      name: senderName,
      telegramUserId: origin.sender_user.id,
      telegramUsername: origin.sender_user.username,
    };
  } else if (origin.type === "hidden_user") {
    senderName = origin.sender_user_name;
    identity = { name: senderName };
  }

  let client: ClientDoc | null = null;
  let created = false;
  if (identity.name) {
    const result = await resolveClient(identity, { createIfMissing: true, source: "telegram" });
    client = result.client ?? null;
    created = result.created;
    if (!client && result.candidates.length && operator.activeClientId) {
      client =
        result.candidates.find((c) => String(c._id) === String(operator.activeClientId)) ?? null;
    }
  }
  if (!client && operator.activeClientId) client = await getClientById(operator.activeClientId);
  if (!client) {
    await sendMessage(
      operator.telegramChatId,
      "No sé de qué cliente es este reenvío. Elige uno con /cliente <nombre> y vuelve a reenviarlo.",
    );
    return;
  }

  await appendMessages({
    clientId: client._id,
    operatorId: operator._id,
    channel: "reenvio",
    messages: [{ sender: "cliente", senderName, text, sentAt: new Date(origin.date * 1000) }],
  });

  const switched = String(operator.activeClientId) !== String(client._id);
  if (switched) await updateOperator(operator._id, { activeClientId: client._id });

  // Solo se avisa al cambiar de cliente, para no responder a cada mensaje de la ráfaga.
  if (switched || created) {
    await sendMessage(
      operator.telegramChatId,
      `📥 Guardando mensajes de <b>${escapeHtml(client.name)}</b>${created ? " (cliente nuevo)" : ""}. Reenvía los que quieras y cuando termines toca el botón.`,
      [[{ text: "💡 Sugerir respuesta", callback_data: `sug:${client._id}` }]],
    );
  }
}

function describeMedia(message: TgMessage): string {
  if (message.photo) return "[foto]";
  if (message.voice) return "[nota de voz]";
  if (message.audio) return "[audio]";
  if (message.video) return "[video]";
  if (message.sticker) return "[sticker]";
  if (message.document)
    return `[archivo${message.document.file_name ? ` ${message.document.file_name}` : ""}]`;
  return "[mensaje sin texto]";
}

/**
 * Mensaje de un chat privado del operador con un cliente, vía Telegram
 * Business. Lucas nunca responde ahí: solo guarda y le avisa al operador.
 */
export async function handleBusinessMessage(
  operator: OperatorDoc,
  message: TgMessage,
): Promise<void> {
  const chat = message.chat;
  if (chat.type !== "private") return;

  const fromTeam = message.from?.id === operator.telegramUserId;
  const clientName =
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
    chat.username ||
    `Telegram ${chat.id}`;

  const { client, created } = await resolveClient(
    { name: clientName, telegramUserId: chat.id, telegramUsername: chat.username },
    { createIfMissing: true, source: "telegram" },
  );
  if (!client) return;

  const text = [message.text ?? message.caption ?? "", message.text ? "" : describeMedia(message)]
    .filter(Boolean)
    .join(" ");

  const previous = await Message.findOne({ client: client._id })
    .sort({ sentAt: -1 })
    .lean<{ sender: string; sentAt: Date }>();

  await appendMessages({
    clientId: client._id,
    operatorId: operator._id,
    channel: "telegram_business",
    messages: [
      {
        sender: fromTeam ? "equipo" : "cliente",
        senderName: fromTeam ? operator.name : clientName,
        text,
        sentAt: new Date(message.date * 1000),
        telegramMessageKey: `b:${message.business_connection_id}:${chat.id}:${message.message_id}`,
      },
    ],
  });

  if (fromTeam) {
    await revisarRespuestaDelEquipo(operator, client, previous);
    return;
  }

  // Un aviso por ráfaga: si el cliente ya venía escribiendo hace poco, no se repite.
  const recentFromClient =
    previous?.sender === "cliente" &&
    Date.now() - new Date(previous.sentAt).getTime() < 10 * 60 * 1000;
  if (recentFromClient && !created) return;

  await sendMessage(
    operator.telegramChatId,
    `💬 <b>${escapeHtml(client.name)}</b>${created ? " (nuevo en el CRM)" : ""} te escribió:\n<i>${escapeHtml(text.slice(0, 300))}</i>`,
    [[{ text: "💡 Sugerir respuesta", callback_data: `sug:${client._id}` }]],
  );
}

/**
 * El asesor acaba de responder en su chat real: Lucas revisa cómo va la
 * atención y avisa al equipo si algo está mal. Solo cuando esa respuesta
 * contesta a un cliente (no en cada mensaje suelto del asesor), para no
 * gastar IA en conversaciones que no lo necesitan.
 */
async function revisarRespuestaDelEquipo(
  operator: OperatorDoc,
  client: ClientDoc,
  previous: { sender: string; sentAt: Date } | null,
): Promise<void> {
  if (previous?.sender !== "cliente") return;
  try {
    const { current } = await getContext(client._id, 0);
    if (!current) return;
    const alerta = await aiService.reviewAttention({ client, current, teamName: operator.name });
    if (alerta.level === "ninguna" || !alerta.message) return;
    await avisarEquipo({
      clientId: client._id,
      clientName: client.name,
      category: alerta.category,
      level: alerta.level,
      text: `${alerta.message}\n\n(Chat de ${operator.name || "un asesor"} por Telegram.)`,
    });
  } catch (error: any) {
    console.error("[lucas] revisión de atención:", error?.message ?? error);
  }
}
