import { Types } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { CLIENT_STAGES } from "../models/client.model";
import { TelegramUpdate } from "../models/telegramUpdate.model";
import { TgCallbackQuery, TgInlineKeyboard, TgMessage, TgUpdate } from "../types/telegram";
import { describirDestino, setAlertChat } from "./alert.service";
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
  leadsCalientes,
  searchClients,
  updateClient,
} from "./client.service";
import { enviarLinkDePago, listarDeudores, pedirLinkDePago } from "./cobros.service";
import { resumenCrm } from "./crm.service";
import { resumenVentas } from "./ventas.service";
import { PerfilNegocio, buscarEntornos } from "./metrics.service";
import {
  actualizarNegocio,
  agregarRegla,
  contextoDeNegocio,
  crearNegocio,
  getNegocio,
  listarNegocios,
  negocioPorCodigo,
  quitarRegla,
} from "./negocio.service";
import {
  findByBusinessConnection,
  findOperator,
  linkOperator,
  OperatorDoc,
  rolParaNegocio,
  setBusinessConnection,
  updateOperator,
} from "./operator.service";
import {
  barraCierre,
  clientCard,
  markChosen,
  recommendForClient,
  stageLabel,
  temperaturaLabel,
} from "./recommendation.service";
import { answerCallback, escapeHtml, removeKeyboard, sendMessage } from "./telegram.service";

const HELP = `Soy <b>Lucas</b> 🧠, tu agente de ventas. Pásame la conversación con tu cliente y te digo qué responderle para cerrar la venta, qué tan cerca estás y cuándo mandarle el pago.

<b>Cómo pasarme una conversación</b>
📸 Mándame una <b>captura</b> del chat de WhatsApp. En el pie de foto puedes contarme algo: <i>"quiere 2 tortas para el sábado, qué le digo"</i>.
📋 O <b>pega</b> la conversación como texto.
↪️ O <b>reenvíame</b> los mensajes si el cliente te escribió por Telegram.

<b>Lo que te devuelvo</b>
🔥 Qué tan cerca estás de cerrar y qué falta
💬 2 o 3 respuestas listas para copiar
💳 Si ya es momento de mandarle el pago, el mensaje con tus datos de pago

<b>Configura tu negocio</b> (una sola vez)
/negocio <i>texto</i>: qué vendes, precios, entregas, condiciones
/pago <i>texto</i>: tus datos de pago (cuentas, link, Payphone, De Una…)
/regla <i>texto</i>: una regla que siempre respeto, por ejemplo <i>no se envían proformas para montos menores a $500</i>
/reglas: ver y quitar reglas

<b>Tus clientes</b>
/calientes: los que están más cerca de comprar
/ventas: cómo va tu mes (tu facturación en Metrics y lo que puedes cerrar)
/cliente <i>nombre o teléfono</i>: buscar y elegir
/nuevo <i>nombre | teléfono</i>: crear
/ficha · /nota <i>texto</i> · /etapa
/sugerir <i>[n] [pedido]</i>: qué responder; <i>/sugerir 0</i> lee solo la conversación actual
/contexto <i>n</i>: cuántas conversaciones anteriores leo por defecto
/soltar: dejar el cliente activo

/alertas: cuándo te aviso (clientes sin respuesta, ventas que se escapan, mala atención). Agrégame a un grupo de tu equipo y escribe ahí /alertasaqui`;

const HELP_BAKANO = `\n\n<b>Equipo Bakano</b>
/alta <i>nombre del negocio</i>: dar de alta a un cliente en Lucas y obtener su código
/negocios: ver los negocios y entrar a uno para configurarlo o probar
/codigo: código de vinculación del negocio en el que estás
/cobros: quién le debe a Bakano
/crm: CRM y WhatsApp conectados de los clientes, y leads que dejaron ir`;

function ayuda(operator: OperatorDoc): string {
  return operator.role === "bakano" ? HELP + HELP_BAKANO : HELP;
}

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
      ? "Primero vincúlate conmigo: abre este chat y manda /vincular <código de tu negocio>. Después vuelve a conectarme en Telegram Business."
      : conn.is_enabled
        ? "🔗 Listo, ya leo tus chats de Telegram. Cuando un cliente te escriba te aviso aquí y te digo qué responder. Nunca le escribo al cliente."
        : "🔌 Me desconectaste de Telegram Business. Ya no leo tus chats.";
    await sendMessage(conn.user_chat_id, text).catch(() => {});
    return;
  }

  if (update.business_message?.business_connection_id) {
    const operator = await findByBusinessConnection(update.business_message.business_connection_id);
    if (operator?.negocio) await handleBusinessMessage(operator, update.business_message);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.from) return;
  // En grupos Lucas no conversa: solo acepta el registro del grupo de avisos.
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
 * /alertasaqui en un grupo: los avisos del negocio (o del equipo de Bakano)
 * llegan ahí en vez del chat privado del dueño.
 */
async function handleGroupMessage(message: TgMessage): Promise<void> {
  const parsed = parseCommand(message.text?.trim() ?? "");
  if (parsed?.command !== "alertasaqui") return;
  const operator = await findOperator(message.from!.id);
  if (!operator || (operator.role !== "bakano" && !operator.negocio)) {
    await sendMessage(
      message.chat.id,
      "Primero vincúlate conmigo por chat privado con /vincular <código>.",
    );
    return;
  }
  if (operator.role === "vendedor") {
    await sendMessage(
      message.chat.id,
      "Solo el dueño del negocio puede registrar el grupo de avisos.",
    );
    return;
  }
  const negocioId = operator.role === "bakano" ? null : operator.negocio;
  await setAlertChat(negocioId, message.chat.id, operator.name);
  await sendMessage(
    message.chat.id,
    negocioId
      ? "📣 Listo, desde ahora aviso aquí: clientes sin respuesta, ventas que se están escapando, mala atención y clientes molestos."
      : "📣 Listo, este es el grupo de avisos del equipo de Bakano.",
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

/**
 * /vincular con el código de un negocio (dueño o vendedor) o con el código
 * interno de Bakano (equipo). Sirve también para cambiarse de negocio.
 */
async function vincular(message: TgMessage, codigo: string): Promise<OperatorDoc | null> {
  const from = message.from!;
  const chatId = message.chat.id;

  if (env.TELEGRAM_LINK_CODE && codigo === env.TELEGRAM_LINK_CODE) {
    const operator = await linkOperator(from, chatId, { negocio: null, role: "bakano" });
    await sendMessage(
      chatId,
      `✅ Listo, ${escapeHtml(from.first_name)}. Entraste como equipo de Bakano.\n\nDa de alta a un cliente con /alta <nombre> o entra a uno con /negocios.${HELP_BAKANO}`,
    );
    return operator;
  }

  const negocio = await negocioPorCodigo(codigo);
  if (!negocio) {
    await sendMessage(chatId, "Ese código no es válido. Pídeselo a tu asesor de Bakano.");
    return null;
  }
  const role = await rolParaNegocio(negocio._id);
  const operator = await linkOperator(from, chatId, { negocio: negocio._id, role });
  await sendMessage(
    chatId,
    `✅ Listo, ${escapeHtml(from.first_name)}. Ya trabajo para <b>${escapeHtml(negocio.nombre)}</b>${
      role === "dueno" ? " (como dueño)" : ""
    }.\n\n${HELP}`,
  );
  return operator;
}

async function handlePrivateMessage(message: TgMessage): Promise<void> {
  const from = message.from!;
  const chatId = message.chat.id;
  const text = message.text?.trim() ?? "";
  const parsed = parseCommand(text);

  if (parsed?.command === "vincular") {
    if (!parsed.args) {
      await sendMessage(
        chatId,
        "Mándame el código de tu negocio así: <code>/vincular código</code>",
      );
      return;
    }
    await vincular(message, parsed.args.trim());
    return;
  }

  let operator = await findOperator(from.id);
  if (!operator) {
    await sendMessage(
      chatId,
      "Hola, soy Lucas 🧠, el agente de ventas de Bakano. Te ayudo a cerrar tus ventas por WhatsApp.\n\nPara empezar manda el código que te dio tu asesor de Bakano:\n<code>/vincular código</code>",
    );
    return;
  }

  // El chat puede cambiar si reinstaló Telegram.
  if (operator.telegramChatId !== chatId) operator = await linkOperator(from, chatId);

  if (parsed) {
    await handleCommand(operator, parsed.command, parsed.args);
    return;
  }
  if (!operator.negocio) {
    await sendMessage(
      chatId,
      operator.role === "bakano"
        ? "Para probar capturas entra primero a un negocio con /negocios."
        : "No estás vinculado a ningún negocio. Usa /vincular <código>.",
    );
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

async function requireNegocio(operator: OperatorDoc): Promise<Types.ObjectId | null> {
  if (operator.negocio) return operator.negocio;
  await sendMessage(
    operator.telegramChatId,
    operator.role === "bakano"
      ? "Primero entra a un negocio con /negocios."
      : "No estás vinculado a ningún negocio. Usa /vincular <código>.",
  );
  return null;
}

async function requireActiveClient(operator: OperatorDoc): Promise<Types.ObjectId | null> {
  if (!(await requireNegocio(operator))) return null;
  if (operator.activeClientId) return operator.activeClientId;
  await sendMessage(
    operator.telegramChatId,
    "Primero elige un cliente con /cliente <nombre o teléfono>.",
  );
  return null;
}

/** Lo que Metrics ya sabe del negocio, para no pedirlo dos veces. */
function resumenPerfilMetrics(p: PerfilNegocio | null): string {
  if (!p) return "";
  return [
    p.descripcion && `• Qué es: ${p.descripcion}`,
    p.productosServicios && `• Qué vendes: ${p.productosServicios}`,
    p.ticketPromedio && `• Ticket promedio: ${p.ticketPromedio}`,
    p.publicoObjetivo && `• A quién le vendes: ${p.publicoObjetivo}`,
    p.propuestaValor && `• Por qué eres distinto: ${p.propuestaValor}`,
    p.porQueTeCompran && `• Por qué te compran: ${p.porQueTeCompran}`,
  ]
    .filter(Boolean)
    .map((l) => String(l).slice(0, 300))
    .join("\n");
}

/** Configurar el negocio: el dueño o el equipo de Bakano, no los vendedores. */
async function puedeConfigurar(operator: OperatorDoc): Promise<boolean> {
  if (operator.role !== "vendedor") return true;
  await sendMessage(operator.telegramChatId, "Eso lo configura el dueño del negocio.");
  return false;
}

async function requireBakano(operator: OperatorDoc): Promise<boolean> {
  if (operator.role === "bakano") return true;
  await sendMessage(operator.telegramChatId, "No conozco ese comando. Mira /ayuda.");
  return false;
}

async function handleCommand(operator: OperatorDoc, command: string, args: string): Promise<void> {
  const chatId = operator.telegramChatId;

  switch (command) {
    case "start":
    case "ayuda":
    case "help":
      await sendMessage(chatId, ayuda(operator));
      return;

    // ─── Leads ────────────────────────────────────────────────────────────────

    case "cliente": {
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      if (!args) {
        if (!operator.activeClientId) {
          await sendMessage(chatId, "Dime a quién busco: /cliente María o /cliente 0991234567");
          return;
        }
        const card = await clientCard(await getClientById(operator.activeClientId, negocioId));
        await sendMessage(chatId, card.html, card.keyboard);
        return;
      }
      const results = await searchClients(args, negocioId);
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
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      const [name, phone] = args.split("|").map((s) => s.trim());
      if (!name) {
        await sendMessage(chatId, "Uso: /nuevo María Pérez | 0991234567");
        return;
      }
      const client = await createClient({
        negocio: negocioId,
        name,
        phones: phone ? [phone] : [],
        source: "telegram",
      });
      await selectClient(operator, client._id, "🆕 Cliente creado.");
      return;
    }

    case "ficha": {
      const clientId = await requireActiveClient(operator);
      if (!clientId) return;
      const card = await clientCard(await getClientById(clientId, operator.negocio));
      await sendMessage(chatId, card.html, card.keyboard);
      return;
    }

    case "calientes": {
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      const leads = await leadsCalientes(negocioId);
      if (!leads.length) {
        await sendMessage(
          chatId,
          "Todavía no tengo clientes medidos en los últimos 14 días. Mándame una captura de una conversación y empiezo.",
        );
        return;
      }
      const lines = ["🔥 <b>Los más cerca de comprar</b>", ""];
      for (const l of leads) {
        lines.push(
          `${temperaturaLabel(l.cierre.temperatura)} · <b>${escapeHtml(l.name)}</b>\n${barraCierre(l.cierre.probabilidad)}${
            l.cierre.falta?.length ? `\n<i>Falta: ${escapeHtml(l.cierre.falta.join(", "))}</i>` : ""
          }`,
        );
      }
      await sendMessage(
        chatId,
        lines.join("\n\n"),
        leads
          .slice(0, 8)
          .map((l) => [{ text: `💡 ${l.name.slice(0, 40)}`, callback_data: `sug:${l._id}` }]),
      );
      return;
    }

    case "ventas": {
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      await resumenVentas(chatId, negocioId);
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
      if (!clientId) return;
      if (!args) {
        await sendMessage(chatId, "Uso: /nota Prefiere que le escriban en la tarde");
        return;
      }
      await getClientById(clientId, operator.negocio);
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
      await getClientById(clientId, operator.negocio);
      const client = await updateClient(clientId, { stage });
      await sendMessage(
        chatId,
        `✅ <b>${escapeHtml(client.name)}</b> ahora está en <b>${stageLabel(stage)}</b>.`,
      );
      return;
    }

    case "soltar":
      await updateOperator(operator._id, { activeClientId: null, pendingAction: "" });
      await sendMessage(chatId, "Listo, sin cliente activo.");
      return;

    // ─── Configuración del negocio ───────────────────────────────────────────

    case "negocio": {
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      const { negocio, perfil } = await contextoDeNegocio(negocioId);
      if (!args) {
        const deMetrics = resumenPerfilMetrics(perfil);
        const partes = [
          deMetrics &&
            `<b>Esto ya lo sé por tu perfil en Metrics</b> (no hace falta repetirlo):\n${escapeHtml(deMetrics)}`,
          negocio.info &&
            `<b>Precios y condiciones que me contaste:</b>\n${escapeHtml(negocio.info)}`,
        ].filter(Boolean);
        await sendMessage(
          chatId,
          partes.length
            ? `${partes.join("\n\n")}\n\n${negocio.info ? "Para reemplazar tus precios y condiciones" : "Cuéntame solo lo que falta: precios, cómo entregas, horarios, zonas y garantías"}: /negocio <texto completo>\n\nTodo lo que me cuentes queda también en tu perfil de Metrics.`
            : "Cuéntame de tu negocio en un solo mensaje: qué vendes, precios, cómo entregas, horarios, zonas, garantías y cualquier condición. Ej:\n<code>/negocio Vendemos tortas personalizadas desde $25, entregas en Cuenca de martes a sábado, pedidos con 2 días de anticipación…</code>\n\nMientras no lo tenga, no afirmo precios.",
        );
        return;
      }
      if (!(await puedeConfigurar(operator))) return;
      await actualizarNegocio(negocioId, { info: args });
      await sendMessage(
        chatId,
        `✅ Guardado. Desde ahora recomiendo con esta información${negocio.workspaceId ? " y quedó también en tu perfil de Metrics" : ""}.`,
      );
      return;
    }

    case "pago": {
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      const { negocio } = await contextoDeNegocio(negocioId);
      if (!args) {
        await sendMessage(
          chatId,
          negocio.datosPago
            ? `<b>Tus datos de pago:</b>\n\n<code>${escapeHtml(negocio.datosPago)}</code>\n\nPara cambiarlos: /pago <texto completo>`
            : "Mándame tus datos de pago tal como se los mandas a tus clientes. Ej:\n<code>/pago Transferencia Banco Pichincha, cta. corriente 2201234567, a nombre de Dulce Hogar, RUC 0102030405001. También aceptamos De Una al 0991234567.</code>",
        );
        return;
      }
      if (!(await puedeConfigurar(operator))) return;
      await actualizarNegocio(negocioId, { datosPago: args });
      await sendMessage(
        chatId,
        `✅ Guardado${negocio.workspaceId ? " aquí y en tu perfil de Metrics" : ""}. Cuando un cliente esté listo para pagar, te doy el mensaje con estos datos.`,
      );
      return;
    }

    case "regla": {
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      if (!args) {
        await sendMessage(
          chatId,
          "Escríbeme la regla que siempre debo respetar. Ej:\n<code>/regla No se envían proformas para montos menores a $500</code>",
        );
        return;
      }
      if (!(await puedeConfigurar(operator))) return;
      const reglas = await agregarRegla(negocioId, args);
      await sendMessage(
        chatId,
        `✅ Regla guardada. Ahora tengo ${reglas.length} regla${reglas.length === 1 ? "" : "s"}. Míralas con /reglas.`,
      );
      return;
    }

    case "reglas": {
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      const { negocio } = await contextoDeNegocio(negocioId);
      const reglas = negocio.reglas;
      if (!reglas.length) {
        await sendMessage(chatId, "Todavía no tienes reglas. Agrega una con /regla <texto>.");
        return;
      }
      const keyboard: TgInlineKeyboard =
        operator.role === "vendedor"
          ? []
          : reglas.map((r, i) => [{ text: `🗑️ Quitar ${i + 1}`, callback_data: `qregla:${i}` }]);
      await sendMessage(
        chatId,
        `<b>Reglas que siempre respeto</b>\n\n${reglas.map((r, i) => `${i + 1}. ${escapeHtml(r)}`).join("\n")}`,
        keyboard,
      );
      return;
    }

    case "alertas":
      await sendMessage(
        chatId,
        `📣 Los avisos llegan ${await describirDestino(operator.role === "bakano" ? null : operator.negocio)}.\n\nTe aviso cuando un cliente lleva más de ${env.LUCAS_SLA_MINUTOS} min sin respuesta, cuando una venta se está escapando, cuando veo mala atención y cuando un cliente está molesto.`,
      );
      return;

    case "alertasaqui":
      await sendMessage(
        chatId,
        "Ese comando se usa dentro del grupo de tu equipo, después de agregarme al grupo.",
      );
      return;

    // ─── Equipo Bakano ───────────────────────────────────────────────────────

    case "alta": {
      if (!(await requireBakano(operator))) return;
      if (!args) {
        await sendMessage(chatId, "Uso: /alta Pastelería Dulce Hogar");
        return;
      }
      const entornos = await buscarEntornos(args).catch(() => []);
      await updateOperator(operator._id, {
        pendingAction: JSON.stringify({ kind: "alta", nombre: args }),
      });
      const keyboard: TgInlineKeyboard = entornos.map((e) => [
        {
          text: `🔗 ${e.nombre.slice(0, 40)}${e.activo ? "" : " (inactivo)"}`,
          callback_data: `alta:${e.id}`,
        },
      ]);
      keyboard.push([{ text: "➕ Crear sin entorno de Metrics", callback_data: "alta:-" }]);
      await sendMessage(
        chatId,
        entornos.length
          ? `Encontré estos entornos en Metrics. Si es uno de ellos, lo enlazo y Lucas toma de ahí sus productos, ticket y tono:`
          : `No encontré "${escapeHtml(args)}" en Metrics. Lo creo sin enlazar?`,
        keyboard,
      );
      return;
    }

    case "negocios": {
      if (!(await requireBakano(operator))) return;
      const negocios = await listarNegocios();
      if (!negocios.length) {
        await sendMessage(chatId, "Todavía no hay negocios. Da de alta uno con /alta <nombre>.");
        return;
      }
      await sendMessage(
        chatId,
        `<b>${negocios.length} negocios en Lucas</b>\nToca uno para entrar como equipo Bakano (configurar, probar capturas):`,
        negocios
          .slice(0, 40)
          .map((n) => [{ text: n.nombre.slice(0, 50), callback_data: `entrar:${n._id}` }]),
      );
      return;
    }

    case "codigo": {
      const negocioId = await requireNegocio(operator);
      if (!negocioId) return;
      if (operator.role === "vendedor") {
        await sendMessage(chatId, "El código lo comparte el dueño del negocio.");
        return;
      }
      const negocio = await getNegocio(negocioId);
      await sendMessage(
        chatId,
        `Código de <b>${escapeHtml(negocio?.nombre ?? "")}</b> para que se vinculen el dueño y sus vendedores:\n\n<code>/vincular ${escapeHtml(negocio?.codigo ?? "")}</code>\n\nEl primero que se vincula queda como dueño.`,
      );
      return;
    }

    case "cobros":
      if (!(await requireBakano(operator))) return;
      await listarDeudores(operator);
      return;

    case "crm":
      if (!(await requireBakano(operator))) return;
      await resumenCrm(operator);
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
  const client = await getClientById(clientId, operator.negocio);
  await updateOperator(operator._id, { activeClientId: client._id });
  const card = await clientCard(client);
  await sendMessage(
    operator.telegramChatId,
    `${prefix ? `${prefix}\n\n` : ""}${card.html}`,
    card.keyboard,
  );
}

async function darDeAlta(operator: OperatorDoc, workspaceId: string): Promise<void> {
  let nombre = "";
  try {
    const pendiente = JSON.parse(operator.pendingAction || "{}");
    if (pendiente.kind === "alta") nombre = pendiente.nombre;
  } catch {
    // pendingAction de otra cosa: se pide de nuevo.
  }
  if (!nombre) {
    await sendMessage(
      operator.telegramChatId,
      "Esa alta ya no está pendiente. Vuelve a escribir /alta <nombre>.",
    );
    return;
  }
  await updateOperator(operator._id, { pendingAction: "" });
  const negocio = await crearNegocio({
    nombre,
    workspaceId: workspaceId === "-" ? "" : workspaceId,
    creadoPor: operator.name,
  });
  await sendMessage(
    operator.telegramChatId,
    [
      `✅ <b>${escapeHtml(negocio.nombre)}</b> dado de alta${negocio.workspaceId ? " y enlazado a su entorno de Metrics" : ""}.`,
      "",
      "Mándale esto al dueño para que empiece:",
      `<code>Escríbele a @LucasByBakanoBot en Telegram y manda: /vincular ${negocio.codigo}</code>`,
      "",
      "El primero que se vincula queda como dueño; después puede pasarle el código a sus vendedores.",
    ].join("\n"),
    [[{ text: "Entrar a este negocio", callback_data: `entrar:${negocio._id}` }]],
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
        const client = await getClientById(value, operator.negocio);
        await updateOperator(operator._id, { activeClientId: client._id });
        await recommendForClient({ operator, clientId: client._id });
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
        const negocioId = await requireNegocio(operator);
        if (!negocioId) return;
        const client = await createClient({ negocio: negocioId, name: value, source: "telegram" });
        await selectClient(operator, client._id, "🆕 Cliente creado.");
        return;
      }
      case "stage": {
        await answerCallback(query.id);
        if (!operator.activeClientId || !isValidStage(value)) return;
        await getClientById(operator.activeClientId, operator.negocio);
        const client = await updateClient(operator.activeClientId, { stage: value });
        if (source) await removeKeyboard(source.chat.id, source.message_id);
        await sendMessage(
          operator.telegramChatId,
          `✅ <b>${escapeHtml(client.name)}</b> ahora está en <b>${stageLabel(value)}</b>.`,
        );
        return;
      }
      case "qregla": {
        if (operator.role === "vendedor" || !operator.negocio) {
          await answerCallback(query.id, "Eso lo configura el dueño del negocio");
          return;
        }
        const reglas = await quitarRegla(operator.negocio, Number(value));
        await answerCallback(query.id, "Regla quitada");
        if (source) await removeKeyboard(source.chat.id, source.message_id);
        await sendMessage(
          operator.telegramChatId,
          reglas.length
            ? `<b>Reglas que siempre respeto</b>\n\n${reglas.map((r, i) => `${i + 1}. ${escapeHtml(r)}`).join("\n")}`
            : "Ya no tienes reglas.",
        );
        return;
      }
      case "alta": {
        await answerCallback(query.id);
        if (operator.role !== "bakano") return;
        if (source) await removeKeyboard(source.chat.id, source.message_id);
        await darDeAlta(operator, value);
        return;
      }
      case "entrar": {
        if (operator.role !== "bakano") {
          await answerCallback(query.id);
          return;
        }
        const negocio = await getNegocio(value);
        if (!negocio) {
          await answerCallback(query.id, "No encontré ese negocio");
          return;
        }
        await updateOperator(operator._id, {
          negocio: negocio._id,
          activeClientId: null,
          pendingAction: "",
        });
        await answerCallback(query.id, `Entraste a ${negocio.nombre}`);
        await sendMessage(
          operator.telegramChatId,
          `Ahora trabajas dentro de <b>${escapeHtml(negocio.nombre)}</b>. Lo que configures (/negocio, /pago, /regla) y las capturas que mandes son de este negocio.`,
        );
        return;
      }
      case "pagar": {
        if (operator.role !== "bakano") {
          await answerCallback(query.id);
          return;
        }
        await answerCallback(query.id, "Revisando el saldo…");
        await pedirLinkDePago(operator, value);
        return;
      }
      case "pagarf": {
        if (operator.role !== "bakano") {
          await answerCallback(query.id);
          return;
        }
        await answerCallback(query.id, "Generando link…");
        const [workspaceId, invoiceId] = value.split(":");
        await enviarLinkDePago(operator, workspaceId, invoiceId);
        return;
      }
      case "usar": {
        const [suggestionId, index] = value.split(":");
        const esPago = index === "pago";
        const ok = await markChosen(suggestionId, esPago ? -1 : Number(index));
        await answerCallback(
          query.id,
          !ok
            ? "No encontré esa sugerencia"
            : esPago
              ? "Anotado: mandaste el pago"
              : `Anotado: usaste la opción ${Number(index) + 1}`,
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
