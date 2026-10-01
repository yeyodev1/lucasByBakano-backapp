import { Types } from "mongoose";
import { env } from "../config/env";
import { IOperator, Operator } from "../models/operator.model";
import { TgUser } from "../types/telegram";

export type OperatorDoc = IOperator & { _id: Types.ObjectId };

export async function findOperator(telegramUserId: number): Promise<OperatorDoc | null> {
  return Operator.findOne({ telegramUserId, isActive: true }).lean<OperatorDoc>();
}

export async function findByBusinessConnection(connectionId: string): Promise<OperatorDoc | null> {
  return Operator.findOne({
    businessConnectionId: connectionId,
    isActive: true,
  }).lean<OperatorDoc>();
}

export async function linkOperator(
  user: TgUser,
  chatId: number,
  vinculo?: { negocio: Types.ObjectId | null; role: IOperator["role"]; email?: string },
): Promise<OperatorDoc> {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return Operator.findOneAndUpdate(
    { telegramUserId: user.id },
    {
      $set: {
        telegramChatId: chatId,
        name,
        username: user.username ?? "",
        isActive: true,
        ...(vinculo ? { negocio: vinculo.negocio, role: vinculo.role, activeClientId: null } : {}),
        ...(vinculo?.email ? { email: vinculo.email.toLowerCase() } : {}),
      },
      $setOnInsert: { contextConversations: env.LUCAS_DEFAULT_CONTEXT },
    },
    { upsert: true, new: true },
  ).lean<OperatorDoc>() as Promise<OperatorDoc>;
}

export async function updateOperator(
  id: Types.ObjectId,
  patch: Partial<
    Pick<
      IOperator,
      | "activeClientId"
      | "contextConversations"
      | "pendingAction"
      | "businessConnectionId"
      | "negocio"
    >
  >,
): Promise<void> {
  await Operator.updateOne({ _id: id }, { $set: patch });
}

/** Al conectar Lucas en Telegram Business se asocia la conexión al operador. */
export async function setBusinessConnection(
  telegramUserId: number,
  connectionId: string,
  enabled: boolean,
): Promise<OperatorDoc | null> {
  return Operator.findOneAndUpdate(
    { telegramUserId },
    { $set: { businessConnectionId: enabled ? connectionId : "" } },
    { new: true },
  ).lean<OperatorDoc>();
}

/** El primero que se vincula a un negocio es su dueño; los siguientes, vendedores. */
export async function rolParaNegocio(negocioId: Types.ObjectId): Promise<"dueno" | "vendedor"> {
  const hayDueno = await Operator.exists({ negocio: negocioId, role: "dueno", isActive: true });
  return hayDueno ? "vendedor" : "dueno";
}
