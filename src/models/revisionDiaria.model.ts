import mongoose, { Schema, Types } from "mongoose";

/**
 * Avance de la revisión de fin de día: cada conversación evaluada se guarda
 * aquí para que el cron siga donde quedó si no alcanzó el tiempo. Cuando está
 * completa se manda a Metrics, que la envía a Dirección por @BakanoAgencyBot.
 */
export interface IRevisionDiaria {
  dia: string;
  estado: "en_curso" | "enviada" | "fallida";
  conversaciones: {
    conversacionId: Types.ObjectId;
    negocio: string;
    lead: string;
    mensajes: number;
    quienAtendio: string;
    resumen: string;
    comoAtendio: string;
    calificacion: "bien" | "regular" | "mal";
    porque: string;
    debioHacer: string;
    usoLucas: string;
  }[];
  /** Conversaciones que la IA no pudo evaluar: no frenan el envío. */
  fallidas: Types.ObjectId[];
  enviadaEn: Date | null;
}

const revisionDiariaSchema = new Schema<IRevisionDiaria>(
  {
    dia: { type: String, required: true, unique: true },
    estado: { type: String, enum: ["en_curso", "enviada", "fallida"], default: "en_curso" },
    conversaciones: {
      type: [
        new Schema(
          {
            conversacionId: { type: Schema.Types.ObjectId, ref: "Conversation" },
            negocio: String,
            lead: String,
            mensajes: Number,
            quienAtendio: String,
            resumen: String,
            comoAtendio: String,
            calificacion: { type: String, enum: ["bien", "regular", "mal"] },
            porque: String,
            debioHacer: String,
            usoLucas: String,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    fallidas: { type: [Schema.Types.ObjectId], default: [] },
    enviadaEn: { type: Date, default: null },
  },
  { timestamps: true },
);

export const RevisionDiaria =
  mongoose.models.RevisionDiaria || mongoose.model<IRevisionDiaria>("RevisionDiaria", revisionDiariaSchema);
