import { Types } from "mongoose";
import { Operator } from "../models/operator.model";
import * as aiService from "./ai.service";
import { contextoDeNegocio } from "./negocio.service";
import { estadoEnMetrics, usuarioPorTelegram, ventasCrm, type AsesorCrm } from "./metrics.service";
import { OperatorDoc } from "./operator.service";
import { escapeHtml, sendMessage, sendTyping } from "./telegram.service";

/**
 * Lucas como coach del equipo de ventas: lee las ventas abiertas del CRM del
 * negocio (por Metrics, que tiene el acceso), y le dice a cada asesor cómo va
 * y qué escribirle a cada lead.
 *
 * /equipo: el dueño (o Bakano) ve a todos sus asesores.
 * /misventas: cada quien ve lo suyo (se le encuentra en el CRM por su correo).
 */

/** El correo de Metrics de la persona; los vinculados antes no lo tenían guardado. */
async function correoDe(operator: OperatorDoc): Promise<string> {
  if (operator.email) return operator.email;
  const usuario = await usuarioPorTelegram(operator.telegramUserId).catch(() => null);
  const email = usuario?.email?.toLowerCase() || "";
  if (email) await Operator.updateOne({ _id: operator._id }, { $set: { email } });
  return email;
}

function montoTexto(n: number): string {
  return n ? ` · $${Math.round(n).toLocaleString("es-EC")} abiertos` : "";
}

async function sinCrm(chatId: number, motivo: string): Promise<void> {
  await sendMessage(
    chatId,
    `🔌 ${escapeHtml(motivo)}\n\nCuando Bakano tenga vinculado el CRM de tu negocio, aquí te digo cómo va cada asesor y qué escribirle a cada cliente.`,
  );
}

async function enviarCoach(operator: OperatorDoc, asesores: AsesorCrm[], titulo: string): Promise<void> {
  const chatId = operator.telegramChatId;
  const negocio = await contextoDeNegocio(operator.negocio);
  const { data } = await aiService.coachEquipo({ negocio, asesores });

  await sendMessage(chatId, `${titulo}\n\n${escapeHtml(data.resumen)}`);
  for (const a of data.asesores) {
    const crudo = asesores.find((x) => x.nombre === a.nombre);
    const lineas = [
      `👤 <b>${escapeHtml(a.nombre)}</b>${crudo ? ` · ${crudo.ventasAbiertas} ventas abiertas${crudo.esperandoRespuesta ? ` · ⚠️ ${crudo.esperandoRespuesta} sin responder` : ""}${montoTexto(crudo.montoAbierto)}` : ""}`,
      escapeHtml(a.comoVa),
      a.alerta ? `🔥 <b>Hoy:</b> ${escapeHtml(a.alerta)}` : "",
      ...a.ventas.map(
        (v) => `\n• <b>${escapeHtml(v.contacto)}</b>: ${escapeHtml(v.situacion)}\n💬 <code>${escapeHtml(v.queEscribir)}</code>`,
      ),
    ].filter(Boolean);
    // Telegram corta en 4096: cada asesor va en su propio mensaje.
    await sendMessage(chatId, lineas.join("\n").slice(0, 4000));
  }
}

/** /equipo: cómo va cada asesor del negocio en el CRM y qué escribe cada uno. */
export async function coachEquipo(operator: OperatorDoc, negocioId: Types.ObjectId): Promise<void> {
  const chatId = operator.telegramChatId;
  const { negocio } = await contextoDeNegocio(negocioId);
  if (!negocio.workspaceId) {
    await sinCrm(chatId, "Este negocio todavía no está vinculado a su entorno de Metrics.");
    return;
  }
  await sendTyping(chatId);
  await sendMessage(chatId, "Dame un momento, estoy leyendo las ventas de tu CRM 👀");
  const ventas = await ventasCrm(String(negocio.workspaceId));
  if (!ventas.disponible) return sinCrm(chatId, ventas.motivo);
  if (!ventas.asesores.length) {
    await sendMessage(chatId, "No encontré ventas abiertas en tu CRM ahora mismo.");
    return;
  }
  await enviarCoach(operator, ventas.asesores, `📊 <b>Cómo va tu equipo de ventas</b>${ventas.truncado ? " (las más recientes)" : ""}`);
}

/** /misventas: lo de quien pregunta, buscándolo en el CRM por su correo. */
export async function coachMisVentas(operator: OperatorDoc, negocioId: Types.ObjectId): Promise<void> {
  const chatId = operator.telegramChatId;
  const { negocio } = await contextoDeNegocio(negocioId);
  if (!negocio.workspaceId) {
    await sinCrm(chatId, "Este negocio todavía no está vinculado a su entorno de Metrics.");
    return;
  }
  const email = await correoDe(operator);
  if (!email) {
    await sendMessage(chatId, "No tengo tu correo de Metrics para buscarte en el CRM. Sal con /salir y vuelve a entrar con tu correo.");
    return;
  }
  await sendTyping(chatId);
  await sendMessage(chatId, "Dame un momento, estoy leyendo tus ventas en el CRM 👀");
  const ventas = await ventasCrm(String(negocio.workspaceId), email);
  if (!ventas.disponible) return sinCrm(chatId, ventas.motivo);
  if (!ventas.asesores.length) {
    await sendMessage(chatId, "No tienes ventas abiertas asignadas en el CRM ahora mismo.");
    return;
  }
  await enviarCoach(operator, ventas.asesores, "📊 <b>Tus ventas en el CRM</b>");
}

/** /metrics: lo que hay del negocio en Metrics (contrato, citas, guiones, CRM...). */
export async function estadoNegocio(operator: OperatorDoc, negocioId: Types.ObjectId): Promise<void> {
  const chatId = operator.telegramChatId;
  const { negocio } = await contextoDeNegocio(negocioId);
  if (!negocio.workspaceId) {
    await sendMessage(chatId, "Este negocio todavía no está vinculado a su entorno de Metrics.");
    return;
  }
  await sendTyping(chatId);
  const e = await estadoEnMetrics(String(negocio.workspaceId));
  if (!e) {
    await sendMessage(chatId, "No pude leer Metrics ahora mismo, intenta en un rato.");
    return;
  }
  const citas = e.citas.length
    ? e.citas.map((c) => `• ${escapeHtml(c.cita)}: ${escapeHtml(c.cuando)} con ${escapeHtml(c.con)}${c.linkMeet ? `\n  🎥 ${escapeHtml(c.linkMeet)}` : ""}`).join("\n")
    : "• Ninguna por ahora";
  await sendMessage(
    chatId,
    [
      `📋 <b>Tu negocio en Metrics</b>`,
      "",
      "✅ <b>Ya está</b>",
      e.yaEsta.length ? e.yaEsta.map((x) => `• ${escapeHtml(x)}`).join("\n") : "• Nada todavía",
      "",
      "⏳ <b>Falta</b>",
      e.falta.length ? e.falta.map((x) => `• ${escapeHtml(x)}`).join("\n") : "• Nada, estás al día",
      "",
      "🗓️ <b>Tus citas</b>",
      citas,
    ]
      .join("\n")
      .slice(0, 4000),
  );
}
