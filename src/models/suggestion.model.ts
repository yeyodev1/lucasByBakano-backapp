import mongoose, { Schema, Types } from "mongoose";

export interface ISuggestedReply {
  tone: string;
  text: string;
}

/** Lo que Lucas recomendó. Sirve para revisar después qué se sugirió y qué se usó. */
export interface ISuggestion {
  client: Types.ObjectId;
  conversation: Types.ObjectId | null;
  operator: Types.ObjectId | null;
  contextConversations: number;
  clientIntent: string;
  summary: string;
  replies: ISuggestedReply[];
  nextStep: string;
  alerts: string[];
  suggestedStage: string;
  chosenReply: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt?: Date;
}

const suggestionSchema = new Schema<ISuggestion>(
  {
    client: { type: Schema.Types.ObjectId, ref: "Client", required: true, index: true },
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", default: null },
    operator: { type: Schema.Types.ObjectId, ref: "Operator", default: null },
    contextConversations: { type: Number, default: 0 },
    clientIntent: { type: String, default: "" },
    summary: { type: String, default: "" },
    replies: {
      type: [{ tone: String, text: String, _id: false }],
      default: [],
    },
    nextStep: { type: String, default: "" },
    alerts: { type: [String], default: [] },
    suggestedStage: { type: String, default: "" },
    chosenReply: { type: Number, default: null },
    model: { type: String, default: "" },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const Suggestion =
  mongoose.models.Suggestion || mongoose.model<ISuggestion>("Suggestion", suggestionSchema);
