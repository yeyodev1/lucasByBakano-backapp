import mongoose, { Schema } from "mongoose";

/**
 * update_id ya procesados. Telegram reintenta el webhook si la respuesta tarda
 * (y una recomendación con IA puede tardar), así que sin esto el operador
 * recibiría la misma sugerencia dos o tres veces.
 */
export interface ITelegramUpdate {
  updateId: number;
  createdAt?: Date;
}

const telegramUpdateSchema = new Schema<ITelegramUpdate>(
  {
    updateId: { type: Number, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Telegram no reintenta más allá de un día: después de eso el registro sobra.
telegramUpdateSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 2 });

export const TelegramUpdate =
  mongoose.models.TelegramUpdate ||
  mongoose.model<ITelegramUpdate>("TelegramUpdate", telegramUpdateSchema);
