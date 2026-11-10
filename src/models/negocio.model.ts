import mongoose, { Schema, Types } from "mongoose";

/**
 * Un cliente de Bakano que usa a Lucas para vender por WhatsApp. Todo lo de
 * Lucas cuelga de aquí: sus leads, su información, sus reglas de venta y sus
 * datos de pago. Un negocio nunca ve los leads de otro.
 */
export interface IDocumento {
  nombre: string;
  tipo: "pdf" | "imagen";
  fileId: string;
  contenido: string;
  creadoEn: Date;
}

export interface INegocio {
  nombre: string;
  // Entorno en Metrics: de ahí salen productos, ticket promedio y tono.
  workspaceId: string;
  // Código que el dueño y sus vendedores mandan con /vincular.
  codigo: string;
  // Qué vende, precios, condiciones, tono. Lo escribe el negocio con /negocio.
  info: string;
  // Reglas de venta que Lucas respeta siempre ("no se envían proformas para montos menores a $500").
  reglas: string[];
  // Cómo se le cobra al lead: cuentas, link de pago, efectivo contra entrega...
  datosPago: string;
  // Flyers y PDFs que mandó el negocio: se guarda lo que dicen (para la IA) y el
  // file_id de Telegram para volver a enviarlos.
  documentos: IDocumento[];
  // Grupo de Telegram del negocio donde llegan los avisos (registrado con /alertasaqui).
  alertChatId: number | null;
  isActive: boolean;
  creadoPor: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const negocioSchema = new Schema<INegocio>(
  {
    nombre: { type: String, required: true, trim: true },
    workspaceId: { type: String, default: "", index: true },
    codigo: { type: String, required: true, unique: true },
    info: { type: String, default: "" },
    reglas: { type: [String], default: [] },
    datosPago: { type: String, default: "" },
    documentos: {
      type: [
        {
          nombre: String,
          tipo: { type: String, enum: ["pdf", "imagen"] },
          fileId: String,
          contenido: String,
          creadoEn: { type: Date, default: Date.now },
          _id: false,
        },
      ],
      default: [],
    },
    alertChatId: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
    creadoPor: { type: String, default: "" },
  },
  { timestamps: true },
);

export type NegocioDoc = INegocio & { _id: Types.ObjectId };

export const Negocio =
  mongoose.models.Negocio || mongoose.model<INegocio>("Negocio", negocioSchema);
