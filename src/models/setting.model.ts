import mongoose, { Schema } from "mongoose";

/**
 * Configuración clave/valor. Hoy guarda "business": qué vende el negocio,
 * precios y tono. Sin esto Lucas recomienda a ciegas.
 */
export interface ISetting {
  key: string;
  value: string;
  updatedBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const settingSchema = new Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export const Setting =
  mongoose.models.Setting || mongoose.model<ISetting>("Setting", settingSchema);
