import mongoose, { Schema, Types } from "mongoose";

export const CONVERSATION_CHANNELS = ["telegram_business", "reenvio", "captura", "texto"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

/**
 * Un tramo de conversación con un cliente. Se abre uno nuevo cuando pasan
 * LUCAS_CONVERSATION_GAP_HOURS sin mensajes: así "cuántas conversaciones de
 * contexto" tiene un significado concreto para el operador.
 */
export interface IConversation {
  client: Types.ObjectId;
  operator: Types.ObjectId | null;
  channel: ConversationChannel;
  startedAt: Date;
  lastMessageAt: Date;
  messageCount: number;
  summary: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const conversationSchema = new Schema<IConversation>(
  {
    client: { type: Schema.Types.ObjectId, ref: "Client", required: true, index: true },
    operator: { type: Schema.Types.ObjectId, ref: "Operator", default: null },
    channel: { type: String, enum: CONVERSATION_CHANNELS, required: true },
    startedAt: { type: Date, default: Date.now },
    lastMessageAt: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 },
    summary: { type: String, default: "" },
  },
  { timestamps: true },
);

conversationSchema.index({ client: 1, lastMessageAt: -1 });

export const Conversation =
  mongoose.models.Conversation || mongoose.model<IConversation>("Conversation", conversationSchema);
