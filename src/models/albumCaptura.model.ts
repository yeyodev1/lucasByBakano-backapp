import mongoose, { Schema } from "mongoose";

/**
 * Álbum de capturas: Telegram manda cada foto de un álbum como un update
 * aparte (y en Vercel cada uno cae en su propia función). La primera foto que
 * llega espera a las demás y procesa todo junto, para que Lucas lea la
 * conversación completa y responda una sola vez.
 */
export interface IAlbumCaptura {
  // chatId:media_group_id
  mediaGroupId: string;
  fotos: { messageId: number; fileId: string; caption: string }[];
  procesado: boolean;
  createdAt?: Date;
}

const albumCapturaSchema = new Schema<IAlbumCaptura>(
  {
    mediaGroupId: { type: String, required: true, unique: true },
    fotos: [
      {
        _id: false,
        messageId: { type: Number, required: true },
        fileId: { type: String, required: true },
        caption: { type: String, default: "" },
      },
    ],
    procesado: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

albumCapturaSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export const AlbumCaptura =
  mongoose.models.AlbumCaptura || mongoose.model<IAlbumCaptura>("AlbumCaptura", albumCapturaSchema);
