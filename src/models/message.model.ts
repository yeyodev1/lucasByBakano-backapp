import mongoose, { Schema, Types } from "mongoose";

export const MESSAGE_SENDERS = ["cliente", "equipo"] as const;
export type MessageSender = (typeof MESSAGE_SENDERS)[number];

export interface IMessage {
  conversation: Types.ObjectId;
  client: Types.ObjectId;
  sender: MessageSender;
  senderName: string;
  text: string;
  sentAt: Date;
  // Id de Telegram para no guardar dos veces el mismo mensaje si el webhook se reintenta.
  telegramMessageKey: string | null;
  createdAt?: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    client: { type: Schema.Types.ObjectId, ref: "Client", required: true, index: true },
    sender: { type: String, enum: MESSAGE_SENDERS, required: true },
    senderName: { type: String, default: "" },
    text: { type: String, required: true },
    sentAt: { type: Date, default: Date.now },
    telegramMessageKey: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ conversation: 1, sentAt: 1 });
messageSchema.index(
  { telegramMessageKey: 1 },
  { unique: true, partialFilterExpression: { telegramMessageKey: { $type: "string" } } },
);

export const Message =
  mongoose.models.Message || mongoose.model<IMessage>("Message", messageSchema);
