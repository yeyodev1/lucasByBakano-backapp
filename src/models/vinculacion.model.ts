import mongoose, { Schema } from "mongoose";

/**
 * Alguien que se está vinculando a Lucas con su correo de Metrics: el código
 * que se le mandó por correo y los entornos a los que puede entrar.
 */
export interface IVinculacion {
  telegramUserId: number;
  email: string;
  codigoHash: string;
  expira: Date;
  intentos: number;
  enviadoEn: Date;
  metricsUserId: string;
  // Entornos permitidos para esta persona; solo a estos se la puede vincular.
  entornos: { id: string; nombre: string; rol: string }[];
  esEquipo: boolean;
  verificado: boolean;
}

const vinculacionSchema = new Schema<IVinculacion>(
  {
    telegramUserId: { type: Number, required: true, unique: true },
    email: { type: String, default: "" },
    codigoHash: { type: String, default: "" },
    expira: { type: Date, default: null },
    intentos: { type: Number, default: 0 },
    enviadoEn: { type: Date, default: null },
    metricsUserId: { type: String, default: "" },
    entornos: { type: [{ id: String, nombre: String, rol: String, _id: false }], default: [] },
    esEquipo: { type: Boolean, default: false },
    verificado: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Vinculacion =
  mongoose.models.Vinculacion || mongoose.model<IVinculacion>("Vinculacion", vinculacionSchema);
