import mongoose, { Schema, Types } from "mongoose";

export const OPERATOR_ROLES = ["dueno", "vendedor", "bakano"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/**
 * Quien usa a Lucas desde Telegram: el dueño de un negocio cliente de Bakano,
 * sus vendedores, o alguien del equipo de Bakano. Solo los vinculados (con
 * /vincular <código>) pueden usarlo, y cada uno trabaja dentro de su negocio.
 */
export interface IOperator {
  telegramUserId: number;
  telegramChatId: number;
  name: string;
  username: string;
  isActive: boolean;
  // Negocio en el que trabaja. El equipo de Bakano puede cambiarlo con /negocios.
  negocio: Types.ObjectId | null;
  role: OperatorRole;
  // Correo de Metrics con el que entró. Con él se encuentra a la persona entre
  // los usuarios del CRM del negocio (sus ventas como asesor).
  email: string;
  // Cliente con el que se está trabajando: capturas y reenvíos sin cliente claro caen aquí.
  activeClientId: Types.ObjectId | null;
  // Conversaciones anteriores del cliente que se leen al recomendar (0 = solo la actual).
  contextConversations: number;
  // Conexión de Telegram Business: permite leer los chats privados del operador con sus clientes.
  businessConnectionId: string;
  // Espera de datos: cuando Lucas pregunta algo y la siguiente respuesta del operador es la contestación.
  pendingAction: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const operatorSchema = new Schema<IOperator>(
  {
    telegramUserId: { type: Number, required: true, unique: true, index: true },
    telegramChatId: { type: Number, required: true },
    name: { type: String, default: "" },
    username: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    negocio: { type: Schema.Types.ObjectId, ref: "Negocio", default: null, index: true },
    role: { type: String, enum: OPERATOR_ROLES, default: "vendedor" },
    email: { type: String, default: "", lowercase: true, trim: true },
    activeClientId: { type: Schema.Types.ObjectId, ref: "Client", default: null },
    contextConversations: { type: Number, default: 10, min: 0, max: 20 },
    businessConnectionId: { type: String, default: "", index: true },
    pendingAction: { type: String, default: "" },
  },
  { timestamps: true },
);

export const Operator =
  mongoose.models.Operator || mongoose.model<IOperator>("Operator", operatorSchema);
