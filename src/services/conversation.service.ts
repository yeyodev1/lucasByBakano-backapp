import { Types } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import {
  Conversation,
  ConversationChannel,
  IConversation,
} from "../models/conversation.model";
import { IMessage, Message, MessageSender } from "../models/message.model";
import { touchLastContact } from "./client.service";

export type ConversationDoc = IConversation & { _id: Types.ObjectId };
export type MessageDoc = IMessage & { _id: Types.ObjectId };

export interface IncomingMessage {
  sender: MessageSender;
  senderName?: string;
  text: string;
  sentAt?: Date;
  telegramMessageKey?: string;
}

export interface ConversationWithMessages {
  conversation: ConversationDoc;
  messages: MessageDoc[];
}

// Tope de mensajes por conversación que se le pasan a la IA: una conversación
// de meses no debe mandar miles de mensajes en cada recomendación.
const MAX_MESSAGES_PER_CONVERSATION = 80;

/**
 * Guarda mensajes en la conversación abierta del cliente o abre una nueva si
 * pasó el tiempo de silencio. Una captura siempre abre conversación nueva
 * cuando se pide con forceNew (el operador dice "esto es otro tema").
 */
export async function appendMessages(params: {
  clientId: Types.ObjectId;
  operatorId: Types.ObjectId | null;
  channel: ConversationChannel;
  messages: IncomingMessage[];
  forceNew?: boolean;
}): Promise<{ conversation: ConversationDoc; saved: number }> {
  const valid = params.messages.filter((m) => m.text?.trim());
  if (!valid.length) throw new CustomError("No hay mensajes para guardar", 400);

  const firstAt = valid[0].sentAt ?? new Date();
  const gapMs = env.LUCAS_CONVERSATION_GAP_HOURS * 60 * 60 * 1000;

  let conversation = params.forceNew
    ? null
    : await Conversation.findOne({ client: params.clientId }).sort({ lastMessageAt: -1 });

  if (conversation && firstAt.getTime() - conversation.lastMessageAt.getTime() > gapMs) {
    conversation = null;
  }
  if (!conversation) {
    conversation = await Conversation.create({
      client: params.clientId,
      operator: params.operatorId,
      channel: params.channel,
      startedAt: firstAt,
      lastMessageAt: firstAt,
    });
  }

  let saved = 0;
  let lastAt = conversation.lastMessageAt;
  for (const m of valid) {
    const sentAt = m.sentAt ?? new Date();
    try {
      await Message.create({
        conversation: conversation._id,
        client: params.clientId,
        sender: m.sender,
        senderName: m.senderName ?? "",
        text: m.text.trim(),
        sentAt,
        telegramMessageKey: m.telegramMessageKey ?? null,
      });
      saved++;
      if (sentAt > lastAt) lastAt = sentAt;
    } catch (error: any) {
      // 11000 = mensaje de Telegram ya guardado (reintento del webhook).
      if (error?.code !== 11000) throw error;
    }
  }

  conversation.messageCount += saved;
  conversation.lastMessageAt = lastAt;
  await conversation.save();
  await touchLastContact(params.clientId, lastAt);

  return { conversation: conversation.toObject() as ConversationDoc, saved };
}

async function loadMessages(conversationId: Types.ObjectId): Promise<MessageDoc[]> {
  const latest = await Message.find({ conversation: conversationId })
    .sort({ sentAt: -1 })
    .limit(MAX_MESSAGES_PER_CONVERSATION)
    .lean<MessageDoc[]>();
  return latest.reverse();
}

/**
 * Contexto para recomendar: la conversación actual completa y las N anteriores.
 * N = 0 significa "solo lo de ahora", útil cuando el historial despista.
 */
export async function getContext(
  clientId: Types.ObjectId,
  previousCount: number,
): Promise<{ current: ConversationWithMessages | null; previous: ConversationWithMessages[] }> {
  const conversations = await Conversation.find({ client: clientId })
    .sort({ lastMessageAt: -1 })
    .limit(1 + Math.max(0, previousCount))
    .lean<ConversationDoc[]>();

  if (!conversations.length) return { current: null, previous: [] };

  const loaded = await Promise.all(
    conversations.map(async (conversation) => ({
      conversation,
      messages: await loadMessages(conversation._id),
    })),
  );

  const [current, ...previous] = loaded;
  // De la más antigua a la más reciente, que es como se lee una historia.
  return { current, previous: previous.reverse() };
}

export async function countConversations(clientId: Types.ObjectId): Promise<number> {
  return Conversation.countDocuments({ client: clientId });
}

export async function setConversationSummary(id: Types.ObjectId, summary: string): Promise<void> {
  await Conversation.updateOne({ _id: id }, { $set: { summary } });
}

export async function listConversations(clientId: string, page = 1) {
  if (!Types.ObjectId.isValid(clientId)) throw new CustomError("Cliente no válido", 400);
  const limit = 20;
  const filter = { client: new Types.ObjectId(clientId) };
  const [items, total] = await Promise.all([
    Conversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<ConversationDoc[]>(),
    Conversation.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getConversation(id: string): Promise<ConversationWithMessages> {
  if (!Types.ObjectId.isValid(id)) throw new CustomError("Conversación no válida", 400);
  const conversation = await Conversation.findById(id).lean<ConversationDoc>();
  if (!conversation) throw new CustomError("Conversación no encontrada", 404);
  const messages = await Message.find({ conversation: conversation._id })
    .sort({ sentAt: 1 })
    .lean<MessageDoc[]>();
  return { conversation, messages };
}
