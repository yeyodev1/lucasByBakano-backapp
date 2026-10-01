import crypto from "crypto";
import { IVinculacion, Vinculacion } from "../models/vinculacion.model";
import { TgMessage, TgUser } from "../types/telegram";
import { codeBlock, layout, sendEmail } from "./email.service";
import { UsuarioMetrics, usuarioPorCorreo, usuarioPorTelegram } from "./metrics.service";
import { getNegocio, negocioDeEntorno } from "./negocio.service";
import { linkOperator, OperatorDoc } from "./operator.service";
import { escapeHtml, sendMessage } from "./telegram.service";

/**
 * Entrada suave a Lucas para los clientes de Bakano: con la misma cuenta de
 * metrics.bakano.ec. Si ya usan @BakanoAgencyBot, Lucas los reconoce por su
 * Telegram; si no, verifican su correo con un código de 6 dígitos.
 */

export const SIN_ACCESO =
  "Por ahora no tienes acceso a Lucas 🙏 Lucas es para negocios con su cuenta de Bakano activa en metrics.bakano.ec. Si crees que es un error, escríbele a tu asesor de Bakano y lo revisamos.";

const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VIGENCIA_MS = 15 * 60_000;
const REENVIO_MS = 60_000;
const MAX_INTENTOS = 5;

function hash(codigo: string): string {
  return crypto.createHash("sha256").update(codigo).digest("hex");
}

function nombreCorto(user: TgUser): string {
  return escapeHtml(user.first_name || "");
}

const PEDIR_CORREO = (user: TgUser) =>
  `Hola ${nombreCorto(user)} 👋 Soy Lucas, tu agente de ventas de Bakano. Te ayudo a cerrar tus ventas por WhatsApp: me pasas la conversación con tu cliente y te digo qué responderle, qué tan cerca estás de cerrar y cuándo cobrar.\n\nPara empezar, escríbeme el correo con el que entras a <b>metrics.bakano.ec</b> 📧`;

function bienvenida(nombreNegocio: string, rol: string, faltaConfigurar: boolean): string {
  const lineas = [
    `Listo 🙌 Ya trabajo para <b>${escapeHtml(nombreNegocio)}</b>${rol === "dueno" ? " y te dejé como dueño" : ""}.`,
    "",
    "Cuando un cliente te escriba por WhatsApp, mándame una <b>captura del chat</b> (o pega la conversación) y te digo qué responderle para cerrar 💬",
  ];
  if (faltaConfigurar && rol === "dueno") {
    lineas.push(
      "",
      "Para recomendarte bien necesito 2 cositas, una sola vez:",
      "💲 /negocio: qué vendes y tus precios",
      "💳 /pago: tus datos de pago",
      "Y si tienes reglas (por ejemplo, desde qué monto das proforma), mándalas con /regla.",
    );
  }
  lineas.push("", "Mira todo lo que hago con /ayuda.");
  return lineas.join("\n");
}

/** Vincula a la persona a un entorno de Metrics (crea el negocio si hace falta). */
async function vincularAEntorno(
  message: TgMessage,
  usuario: Pick<UsuarioMetrics, "nombre" | "entornos"> & { email?: string },
  entornoId: string,
): Promise<OperatorDoc | null> {
  const entorno = usuario.entornos.find((e) => e.id === entornoId);
  if (!entorno) return null;
  const negocio = await negocioDeEntorno(entorno.id, entorno.nombre, usuario.nombre);
  const role = entorno.rol === "admin" ? "dueno" : "vendedor";
  const operator = await linkOperator(message.from!, message.chat.id, {
    negocio: negocio._id,
    role,
    email: usuario.email,
  });
  const actual = await getNegocio(negocio._id);
  await sendMessage(
    message.chat.id,
    bienvenida(negocio.nombre, role, !actual?.info || !actual?.datosPago),
  );
  return operator;
}

async function vincularUsuario(
  message: TgMessage,
  usuario: UsuarioMetrics,
): Promise<OperatorDoc | null> {
  if (usuario.esEquipo) {
    const operator = await linkOperator(message.from!, message.chat.id, {
      negocio: null,
      role: "bakano",
      email: usuario.email,
    });
    await sendMessage(
      message.chat.id,
      `Hola ${nombreCorto(message.from!)} 👋 Entraste como equipo de Bakano. Entra a un negocio con /negocios o da de alta uno con /alta. Mira /ayuda.`,
    );
    return operator;
  }
  if (!usuario.entornos.length) {
    await sendMessage(message.chat.id, SIN_ACCESO);
    return null;
  }
  if (usuario.entornos.length === 1)
    return vincularAEntorno(message, usuario, usuario.entornos[0].id);

  await sendMessage(
    message.chat.id,
    "Tienes más de un negocio en Metrics. Con cuál trabajamos? 👇",
    usuario.entornos.map((e) => [{ text: e.nombre.slice(0, 50), callback_data: `ent:${e.id}` }]),
  );
  return null;
}

/**
 * Mensaje de alguien que todavía no está vinculado. Devuelve el operador si
 * quedó vinculado en este paso.
 */
export async function atenderSinVincular(message: TgMessage): Promise<OperatorDoc | null> {
  const from = message.from!;
  const chatId = message.chat.id;
  const texto = message.text?.trim() ?? "";

  // 1. Ya verificó su correo en @BakanoAgencyBot: se le reconoce sin preguntar.
  const porTelegram = await usuarioPorTelegram(from.id);
  if (porTelegram) {
    await Vinculacion.updateOne(
      { telegramUserId: from.id },
      {
        $set: {
          email: porTelegram.email,
          metricsUserId: porTelegram.userId,
          entornos: porTelegram.entornos,
          esEquipo: porTelegram.esEquipo,
          verificado: true,
          codigoHash: "",
        },
      },
      { upsert: true },
    );
    return vincularUsuario(message, porTelegram);
  }

  const pendiente = await Vinculacion.findOne({ telegramUserId: from.id }).lean<IVinculacion>();

  // 2. Está escribiendo el código que le llegó al correo.
  if (pendiente?.codigoHash && /^\d{6}$/.test(texto.replace(/\s/g, ""))) {
    if (!pendiente.expira || new Date(pendiente.expira).getTime() < Date.now()) {
      await sendMessage(
        chatId,
        "Ese código ya venció ⏰ Escríbeme de nuevo tu correo y te mando otro.",
      );
      return null;
    }
    if (pendiente.intentos >= MAX_INTENTOS) {
      await sendMessage(
        chatId,
        "Muchos intentos 😅 Escríbeme de nuevo tu correo y te mando un código nuevo.",
      );
      return null;
    }
    if (hash(texto.replace(/\s/g, "")) !== pendiente.codigoHash) {
      await Vinculacion.updateOne({ telegramUserId: from.id }, { $inc: { intentos: 1 } });
      await sendMessage(
        chatId,
        "Ese código no coincide. Revisa el correo y vuelve a intentarlo 🙏",
      );
      return null;
    }
    await Vinculacion.updateOne(
      { telegramUserId: from.id },
      { $set: { verificado: true, codigoHash: "", intentos: 0 } },
    );
    return vincularUsuario(message, {
      userId: pendiente.metricsUserId,
      nombre: from.first_name,
      email: pendiente.email,
      esEquipo: pendiente.esEquipo,
      entornos: pendiente.entornos as UsuarioMetrics["entornos"],
    });
  }

  // 3. Mandó su correo: se busca en Metrics y se le manda el código.
  if (CORREO_RE.test(texto)) {
    const correo = texto.toLowerCase();
    if (
      pendiente?.email === correo &&
      pendiente.enviadoEn &&
      Date.now() - new Date(pendiente.enviadoEn).getTime() < REENVIO_MS
    ) {
      await sendMessage(
        chatId,
        "Ya te mandé el código a ese correo hace un momento. Revisa también en spam 📬",
      );
      return null;
    }
    const usuario = await usuarioPorCorreo(correo);
    if (!usuario) {
      await sendMessage(
        chatId,
        `No encuentro <b>${escapeHtml(correo)}</b> en metrics.bakano.ec 🤔 Revisa que sea el mismo correo con el que entras ahí, o pídele a tu asesor de Bakano que te ayude.`,
      );
      return null;
    }
    const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const enviado = await sendEmail(
      correo,
      `${codigo} es tu código para entrar a Lucas`,
      layout(
        `¡Hola, ${escapeHtml(usuario.nombre)}! 👋`,
        `<p style="margin:0 0 12px">Soy Lucas, el agente de ventas de Bakano. Ya casi estamos: mándame este código por Telegram y empezamos a trabajar juntos.</p>
        ${codeBlock(codigo)}
        <p style="margin:0 0 12px">Desde ahí me pasas tus conversaciones de WhatsApp y te digo qué responder, qué tan cerca está cada cliente de comprar y cuándo mandar el pago. Todo lo que me cuentes lo recuerdo, así que nunca tienes que explicarme dos veces.</p>
        <p style="margin:0;color:#6b6478;font-size:13px">El código vence en 15 minutos. Si no fuiste tú, ignora este correo y no pasa nada.</p>`,
      ),
    );
    if (!enviado) {
      await sendMessage(
        chatId,
        "No pude mandarte el correo ahora mismo 😕 Mientras lo arreglamos, pídele a tu asesor de Bakano tu código de Lucas.",
      );
      return null;
    }
    await Vinculacion.updateOne(
      { telegramUserId: from.id },
      {
        $set: {
          email: correo,
          codigoHash: hash(codigo),
          expira: new Date(Date.now() + VIGENCIA_MS),
          intentos: 0,
          enviadoEn: new Date(),
          metricsUserId: usuario.userId,
          entornos: usuario.entornos,
          esEquipo: usuario.esEquipo,
          verificado: false,
        },
      },
      { upsert: true },
    );
    await sendMessage(
      chatId,
      `Te mandé un código de 6 dígitos a <b>${escapeHtml(correo)}</b> 📬 Escríbemelo aquí.`,
    );
    return null;
  }

  // 4. Cualquier otra cosa: bienvenida y se pide el correo.
  await sendMessage(
    chatId,
    pendiente?.codigoHash
      ? "Escríbeme el código de 6 dígitos que te llegó al correo, o mándame otro correo si te equivocaste 📬"
      : PEDIR_CORREO(from),
  );
  return null;
}

/** Botón para elegir negocio cuando la persona tiene varios en Metrics. */
export async function elegirEntorno(
  message: TgMessage,
  from: TgUser,
  entornoId: string,
): Promise<boolean> {
  const pendiente = await Vinculacion.findOne({
    telegramUserId: from.id,
    verificado: true,
  }).lean<IVinculacion>();
  if (!pendiente) return false;
  const operator = await vincularAEntorno(
    { ...message, from },
    {
      nombre: from.first_name,
      email: pendiente.email,
      entornos: pendiente.entornos as UsuarioMetrics["entornos"],
    },
    entornoId,
  );
  return Boolean(operator);
}
