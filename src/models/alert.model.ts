import mongoose, { Schema, Types } from "mongoose";

export const ALERT_CATEGORIES = [
  "mala_atencion",
  "sin_respuesta",
  "cliente_molesto",
  "cliente_en_riesgo",
  "oportunidad",
  "cobro",
  "otro",
] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export const ALERT_LEVELS = ["aviso", "urgente"] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/**
 * Aviso de Lucas al equipo. Se guarda para no repetir el mismo aviso del
 * mismo cliente una y otra vez (cada recomendación lo volvería a detectar).
 */
export interface IAlert {
  client: Types.ObjectId | null;
  category: AlertCategory;
  level: AlertLevel;
  text: string;
  // Clave para no repetir: p. ej. el id del último mensaje sin responder.
  dedupeKey: string;
  createdAt?: Date;
}

const alertSchema = new Schema<IAlert>(
  {
    client: { type: Schema.Types.ObjectId, ref: "Client", default: null, index: true },
    category: { type: String, enum: ALERT_CATEGORIES, required: true },
    level: { type: String, enum: ALERT_LEVELS, required: true },
    text: { type: String, required: true },
    dedupeKey: { type: String, default: "", index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

alertSchema.index({ client: 1, category: 1, createdAt: -1 });

export const Alert = mongoose.models.Alert || mongoose.model<IAlert>("Alert", alertSchema);
