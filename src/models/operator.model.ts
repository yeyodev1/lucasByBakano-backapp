import mongoose, { Schema, Types } from "mongoose";

/**
 * Miembro del equipo que usa a Lucas desde Telegram. Solo los operadores
 * vinculados (con /vincular <código>) pueden pedirle recomendaciones: el bot
 * lee datos del CRM y no puede quedar abierto a cualquiera que lo encuentre.
 */
export interface IOperator {
  telegramUserId: number;
  telegramChatId: number;
  name: string;
  username: string;
  isActive: boolean;
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
    activeClientId: { type: Schema.Types.ObjectId, ref: "Client", default: null },
    contextConversations: { type: Number, default: 3, min: 0, max: 20 },
    businessConnectionId: { type: String, default: "", index: true },
    pendingAction: { type: String, default: "" },
  },
  { timestamps: true },
);

export const Operator =
  mongoose.models.Operator || mongoose.model<IOperator>("Operator", operatorSchema);
