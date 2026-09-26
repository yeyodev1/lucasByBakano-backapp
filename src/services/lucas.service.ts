import { Types } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { CLIENT_STAGES } from "../models/client.model";
import { TelegramUpdate } from "../models/telegramUpdate.model";
import { TgCallbackQuery, TgMessage, TgUpdate } from "../types/telegram";
import {
  handleBusinessMessage,
  handleCapture,
  handleForward,
  readPendingCapture,
  resolvePendingCapture,
} from "./capture.service";
import {
  addNote,
  createClient,
  getClientById,
  isValidStage,
  searchClients,
  updateClient,
} from "./client.service";
import {
  findByBusinessConnection,
  findOperator,
  linkOperator,
  OperatorDoc,
  setBusinessConnection,
  updateOperator,
} from "./operator.service";
import { clientCard, markChosen, recommendForClient, stageLabel } from "./recommendation.service";
import { describirDestino, setAlertChat } from "./alert.service";
import { enviarLinkDePago, listarDeudores, pedirLinkDePago } from "./cobros.service";
import { resumenCrm } from "./crm.service";
import { BUSINESS_KEY, getSetting, setSetting } from "./setting.service";
import { answerCallback, escapeHtml, removeKeyboard, sendMessage } from "./telegram.service";

const HELP = `Soy <b>Lucas</b> 🧠, tu copiloto de ventas. Leo tus conversaciones con clientes, reviso el CRM y te digo qué responder.

<b>Cómo pasarme una conversación</b>
📸 Mándame una <b>captura</b> del chat (WhatsApp, Instagram, lo que sea). Puedes escribir en el pie de foto quién es o qué necesitas: <i>"es María de Construmia, quiere descuento"</i>.
📋 <b>Pega</b> la conversación como texto.
↪️ <b>Reenvíame</b> mensajes de un chat de Telegram.
🔗 Conéctame en <b>Telegram Business</b> (Ajustes → Telegram Business → Chatbots → @LucasByBakanoBot) y leo tus chats privados solo, sin responder nunca a tus clientes.

<b>Comandos</b>
/cliente <i>nombre o teléfono</i>: buscar y elegir cliente
/nuevo <i>nombre | teléfono</i>: crear cliente
/ficha: ver la ficha del cliente activo
/sugerir <i>[n] [instrucción]</i>: qué responder. <i>/sugerir 0</i> lee solo la conversación actual; <i>/sugerir 5 quiere precio</i> lee 5 anteriores y toma en cuenta tu pedido
/contexto <i>n</i>: cuántas conversaciones anteriores leo por defecto
/nota <i>texto</i>: nota en la ficha
/etapa <i>etapa</i>: ${CLIENT_STAGES.join(", ")}
/negocio <i>texto</i>: qué vendemos, precios y condiciones (sin esto no afirmo precios)
/alertas: a dónde y cuándo aviso al equipo. Agrégame a un grupo del equipo y escribe ahí /alertasaqui para que los avisos lleguen al grupo
/crm: qué clientes tienen su CRM (GoHighLevel) y WhatsApp conectados, y quiénes dejaron ir leads
/cobros: quién le debe a Bakano, con botón para generar el link de pago
/soltar: dejar el cliente activo

Si el cliente ya está en Metrics te digo si su entorno está activo y si tiene saldo pendiente. Con el botón 💳 te genero el link de pago de Stripe y el mensaje listo para mandarle.`;

/** Punto de entrada de cada update de Telegram (webhook o polling). */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  // Telegram reintenta si tardamos: el update_id único corta los duplicados.
  try {
    await TelegramUpdate.create({ updateId: update.update_id });
  } catch (error: any) {
    if (error?.code === 11000) return;
    throw error;
  }

  if (update.business_connection) {
    const conn = update.business_connection;
    const operator = await setBusinessConnection(conn.user.id, conn.id, conn.is_enabled);
    const text = !operator
      ? `Primero vincúlate conmigo: abre este chat y manda /vincular <código>. Después vuelve a conectarme en Telegram Business.`
      : conn.is_enabled
        ? "🔗 Listo, ya leo tus chats privados. Cuando un cliente te escriba te aviso aquí y te digo qué responder. Nunca le escribo al cliente."
        : "🔌 Me desconectaste de Telegram Business. Ya no leo tus chats.";
    await sendMessage(conn.user_chat_id, text).catch(() => {});
    return;
  }

  if (update.business_message?.business_connection_id) {
    const operator = await findByBusinessConnection(update.business_message.business_connection_id);
    if (operator) await handleBusinessMessage(operator, update.business_message);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.from) return;
  // En grupos Lucas no conversa: solo acepta el registro del grupo de alertas.
  if (message.chat.type !== "private") {
    await handleGroupMessage(message).catch((error) => console.error("[lucas] grupo:", error));
    return;
  }

  try {
    await handlePrivateMessage(message);
  } catch (error) {
    await replyError(message.chat.id, error);
  }
}

/**
 * /alertasaqui <código> en un grupo del equipo: desde ahí llegan los avisos
 * (mala atención, clientes sin respuesta, clientes molestos, oportunidades).
 */
async function handleGroupMessage(message: TgMessage): Promise<void> {
  const parsed = parseCommand(message.text?.trim() ?? "");
  if (parsed?.command !== "alertasaqui") return;
  const operator = await findOperator(message.from!.id);
  const codigoOk = env.TELEGRAM_LINK_CODE && parsed.args === env.TELEGRAM_LINK_CODE;
  if (!operator && !codigoOk) {
    await sendMessage(
      message.chat.id,
      "Solo un operador vinculado a Lucas puede registrar este grupo.",
    );
    return;
  }
  await setAlertChat(message.chat.id, operator?.name ?? message.from!.first_name);
  await sendMessage(
    message.chat.id,
    "📣 Listo, desde ahora aviso aquí al equipo: clientes sin respuesta, atención a revisar, clientes molestos o en riesgo, oportunidades y cobros.",
  );
}

async function replyError(chatId: number, error: unknown): Promise<void> {
  const known = error instanceof CustomError && error.status < 500;
  const text =
    error instanceof CustomError
      ? `😕 ${escapeHtml(error.message)}`
      : "😕 Algo falló de mi lado. Intenta otra vez en un momento.";
  await sendMessage(chatId, text).catch(() => {});
  if (!known) console.error("[lucas]", error);
}

/** callback_data admite 64 bytes: los nombres con tildes ocupan más de un byte por letra. */
function fitCallbackData(value: string, maxBytes: number): string {
  let out = value;
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return out;
}

function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^\/([a-zA-Z_]+)(?:@\w+)?\s*([\s\S]*)$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2].trim() };
}

async function handlePrivateMessage(message: TgMessage): Promise<void> {
  const from = message.from!;
  const chatId = message.chat.id;
  const text = message.text?.trim() ?? "";
  const parsed = parseCommand(text);

  let operator = await findOperator(from.id);

  if (!operator) {
    if (parsed?.command === "vincular") {
      if (!env.TELEGRAM_LINK_CODE || parsed.args !== env.TELEGRAM_LINK_CODE) {
        await sendMessage(chatId, "Ese código no es válido. Pídeselo al administrador de Lucas.");
        return;
      }
      operator = await linkOperator(from, chatId);
      await sendMessage(
        chatId,
        `✅ Listo, ${escapeHtml(from.first_name)}. Ya trabajamos juntos.\n\n${HELP}`,
      );
      return;
    }
    await sendMessage(
      chatId,
      `Hola, soy Lucas 🧠, el copiloto de ventas del equipo. Para usarme manda:\n<code>/vincular código</code>\n\nTu id de Telegram es <code>${from.id}</code>.`,
    );
    return;
  }

  // El chat puede cambiar si el operador reinstaló Telegram.
  if (operator.telegramChatId !== chatId) operator = await linkOperator(from, chatId);

  if (parsed) {
    await handleCommand(operator, parsed.command, parsed.args);
    return;
  }
  if (message.forward_origin) {
    await handleForward(operator, message);
    return;
  }
  if (message.photo || message.document?.mime_type?.startsWith("image/")) {
    await handleCapture(operator, message);
    return;
  }
  if (text) {
    await handleCapture(operator, message, text);
    return;
  }
  await sendMessage(
    chatId,
    "Por ahora leo capturas, texto y reenvíos. Las notas de voz vienen pronto.",
  );
}

async function requireActiveClient(operator: OperatorDoc): Promise<Types.ObjectId | null> {
  if (operator.activeClientId) return operator.activeClientId;
  await sendMessage(
    operator.telegramChatId,
    "Primero elige un cliente con /cliente <nombre o teléfono>.",
  );
  return null;
}

async function handleCommand(operator: OperatorDoc, command: string, args: string): Promise<void> {
  const chatId = operator.telegramChatId;

  switch (command) {
    case "start":
    case "ayuda":
    case "help":
      await sendMessage(chatId, HELP);
      return;

    case "vincular":
      await sendMessage(chatId, "Ya estás vinculado 👍");
      return;

    case "cliente": {
      if (!args) {
        if (!operator.activeClientId) {
          await sendMessage(chatId, "Dime a quién busco: /cliente María o /cliente 0991234567");
          return;
        }
        const card = await clientCard(await getClientById(operator.activeClientId));
        await sendMessage(chatId, card.html, card.keyboard);
        return;
      }
      const results = await searchClients(args);
      if (!results.length) {
        await sendMessage(chatId, `No encontré a "${escapeHtml(args)}".`, [
          [
            {
              text: `➕ Crear "${args.slice(0, 40)}"`,
              callback_data: `new:${fitCallbackData(args, 58)}`,
            },
          ],
        ]);
        return;
      }
      if (results.length === 1) {
        await selectClient(operator, results[0]._id);
        return;
      }
      await sendMessage(
        chatId,
        "Encontré varios. Cuál es?",
        results.map((c) => [
          {
            text: `${c.name}${c.company ? ` · ${c.company}` : ""} · ${stageLabel(c.stage)}`,
            callback_data: `sel:${c._id}`,
          },
        ]),
      );
      return;
    }

    case "nuevo": {
      const [name, phone] = args.split("|").map((s) => s.trim());
      if (!name) {
        await sendMessage(chatId, "Uso: /nuevo María Pérez | 0991234567");
        return;
      }
      const client = await createClient({ name, phones: phone ? [phone] : [], source: "telegram" });
      await selectClient(operator, client._id, "🆕 Cliente creado.");
      return;
    }

    case "ficha": {
      const clientId = await requireActiveClient(operator);
      if (!clientId) return;
      const card = await clientCard(await getClientById(clientId));
      await sendMessage(chatId, card.html, card.keyboard);
      return;
    }

    case "sugerir": {
      const clientId = await requireActiveClient(operator);
      if (!clientId) return;
      const match = args.match(/^(\d{1,2})\b\s*([\s\S]*)$/);
      const contextOverride = match ? Math.min(20, Number(match[1])) : undefined;
      const instruction = (match ? match[2] : args).trim() || undefined;
      await recommendForClient({ operator, clientId, instruction, contextOverride });
      return;
    }

    case "contexto": {
      if (!args) {
        await sendMessage(
          chatId,
          `Leo <b>${operator.contextConversations}</b> conversación(es) anterior(es) además de la actual. Cámbialo con /contexto 0 a 20.`,
        );
        return;
      }
      const n = Number(args);
      if (!Number.isInteger(n) || n < 0 || n > 20) {
        await sendMessage(chatId, "Usa un número entre 0 y 20. Ej: /contexto 3");
        return;
      }
      await updateOperator(operator._id, { contextConversations: n });
      await sendMessage(
        chatId,
        n === 0
          ? "Listo: solo leeré la conversación actual."
          : `Listo: leeré la conversación actual y ${n} anterior${n === 1 ? "" : "es"}.`,
      );
      return;
    }

    case "nota": {
      const clientId = await requireActiveClient(operator);
      if (!clientId || !args) {
        if (clientId) await sendMessage(chatId, "Uso: /nota Prefiere que le escriban en la tarde");
        return;
      }
      const client = await addNote(clientId, args, operator.name);
      await sendMessage(chatId, `📝 Nota guardada en <b>${escapeHtml(client.name)}</b>.`);
      return;
    }

    case "etapa": {
      const clientId = await requireActiveClient(operator);
      if (!clientId) return;
      const stage = args.toLowerCase();
      if (!isValidStage(stage)) {
        await sendMessage(
          chatId,
          "A qué etapa lo paso?",
          CLIENT_STAGES.map((s) => [{ text: stageLabel(s), callback_data: `stage:${s}` }]),
        );
        return;
      }
      const client = await updateClient(clientId, { stage });
      await sendMessage(
        chatId,
        `✅ <b>${escapeHtml(client.name)}</b> ahora está en <b>${stageLabel(stage)}</b>.`,
      );
      return;
    }

    case "negocio": {
      if (!args) {
        const business = await getSetting(BUSINESS_KEY);
        await sendMessage(
          chatId,
          business
            ? `<b>Lo que sé del negocio:</b>\n\n${escapeHtml(business)}\n\nPara reemplazarlo: /negocio <texto completo>`
            : "Todavía no sé qué vendemos. Mándame /negocio con los servicios, precios, condiciones y el tono con el que hablamos. Mientras tanto no afirmo precios.",
        );
        return;
      }
      await setSetting(BUSINESS_KEY, args, operator.name);
      await sendMessage(chatId, "✅ Guardado. Desde ahora recomiendo con esta información.");
      return;
    }

    case "alertas":
      await sendMessage(
        chatId,
        `📣 Los avisos al equipo van ${await describirDestino()}.\n\nAviso cuando un cliente lleva más de ${env.LUCAS_SLA_MINUTOS} min sin respuesta, cuando veo mala atención, clientes molestos o en riesgo, oportunidades de venta y reclamos de cobro.`,
      );
      return;

    case "alertasaqui":
      await sendMessage(
        chatId,
        "Ese comando se usa dentro del grupo del equipo, después de agregarme al grupo.",
      );
      return;

    case "crm":
      await resumenCrm(operator);
      return;

    case "cobros":
      await listarDeudores(operator);
      return;

    case "soltar":
      await updateOperator(operator._id, { activeClientId: null, pendingAction: "" });
      await sendMessage(chatId, "Listo, sin cliente activo.");
      return;

    default:
      await sendMessage(chatId, "No conozco ese comando. Mira /ayuda.");
  }
}

async function selectClient(
  operator: OperatorDoc,
  clientId: Types.ObjectId,
  prefix?: string,
): Promise<void> {
  // Si había una captura esperando cliente, elegir cliente la resuelve.
  if (readPendingCapture(operator)) {
    await resolvePendingCapture(operator, clientId);
    return;
  }
  await updateOperator(operator._id, { activeClientId: clientId });
  const card = await clientCard(await getClientById(clientId));
  await sendMessage(
    operator.telegramChatId,
    `${prefix ? `${prefix}\n\n` : ""}${card.html}`,
    card.keyboard,
  );
}

async function handleCallback(query: TgCallbackQuery): Promise<void> {
  const operator = await findOperator(query.from.id);
  if (!operator) {
    await answerCallback(query.id, "Primero vincúlate con /vincular");
    return;
  }
  const data = query.data ?? "";
  const [action, ...rest] = data.split(":");
  const value = rest.join(":");
  const source = query.message;

  try {
    switch (action) {
      case "sug": {
        await answerCallback(query.id, "Pensando…");
        const clientId = new Types.ObjectId(value);
        await updateOperator(operator._id, { activeClientId: clientId });
        await recommendForClient({ operator, clientId });
        return;
      }
      case "sel":
      case "cap": {
        await answerCallback(query.id);
        if (source) await removeKeyboard(source.chat.id, source.message_id);
        await selectClient(operator, new Types.ObjectId(value));
        return;
      }
      case "capnew": {
        await answerCallback(query.id);
        if (source) await removeKeyboard(source.chat.id, source.message_id);
        const ok = await resolvePendingCapture(operator, null);
        if (!ok)
          await sendMessage(
            operator.telegramChatId,
            "Esa captura ya no está pendiente. Mándala de nuevo.",
          );
        return;
      }
      case "new": {
        await answerCallback(query.id);
        if (source) await removeKeyboard(source.chat.id, source.message_id);
        const client = await createClient({ name: value, source: "telegram" });
        await selectClient(operator, client._id, "🆕 Cliente creado.");
        return;
      }
      case "stage": {
        await answerCallback(query.id);
        if (!operator.activeClientId || !isValidStage(value)) return;
        const client = await updateClient(operator.activeClientId, { stage: value });
        if (source) await removeKeyboard(source.chat.id, source.message_id);
        await sendMessage(
          operator.telegramChatId,
          `✅ <b>${escapeHtml(client.name)}</b> ahora está en <b>${stageLabel(value)}</b>.`,
        );
        return;
      }
      case "pagar": {
        await answerCallback(query.id, "Revisando el saldo…");
        await pedirLinkDePago(operator, value);
        return;
      }
      case "pagarf": {
        await answerCallback(query.id, "Generando link…");
        const [workspaceId, invoiceId] = value.split(":");
        await enviarLinkDePago(operator, workspaceId, invoiceId);
        return;
      }
      case "usar": {
        const [suggestionId, index] = value.split(":");
        const ok = await markChosen(suggestionId, Number(index));
        await answerCallback(
          query.id,
          ok ? `Anotado: usaste la opción ${Number(index) + 1}` : "No encontré esa sugerencia",
        );
        return;
      }
      default:
        await answerCallback(query.id);
    }
  } catch (error) {
    await answerCallback(query.id);
    await replyError(operator.telegramChatId, error);
  }
}
