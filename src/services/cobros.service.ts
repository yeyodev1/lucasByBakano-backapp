import { env } from "../config/env";
import { TgInlineKeyboard } from "../types/telegram";
import {
  cobroDeEntorno,
  enLotes,
  FacturaAbierta,
  financesConfigurado,
  linkDePago,
  periodoLegible,
} from "./finances.service";
import { entornoPorId, listarEntornos } from "./metrics.service";
import { OperatorDoc } from "./operator.service";
import { escapeHtml, sendMessage, sendTyping } from "./telegram.service";

function faltaConfiguracion(): string {
  const faltan = [
    !env.METRICS_DB_URI && "METRICS_DB_URI",
    !env.FINANCES_API_URL && "FINANCES_API_URL",
    !env.FINANCES_PORTAL_KEY && "FINANCES_PORTAL_KEY",
  ].filter(Boolean);
  return faltan.length ? `Para ver cobros me falta configurar: ${faltan.join(", ")}.` : "";
}

/**
 * /cobros: recorre los entornos de Metrics y lista los que deben a Bakano,
 * los vencidos primero. Cada uno trae su botón para generar el link de pago.
 */
export async function listarDeudores(operator: OperatorDoc): Promise<void> {
  const chatId = operator.telegramChatId;
  const falta = faltaConfiguracion();
  if (falta) {
    await sendMessage(chatId, falta);
    return;
  }
  await sendTyping(chatId);

  const entornos = await listarEntornos();
  const cobros = await enLotes(entornos, 5, async (e) => ({
    entorno: e,
    cobro: await cobroDeEntorno(e.id),
  }));
  const deudores = cobros
    .filter((c) => c.cobro && c.cobro.saldoPendiente > 0)
    .sort(
      (a, b) =>
        b.cobro!.vencidas - a.cobro!.vencidas || b.cobro!.saldoPendiente - a.cobro!.saldoPendiente,
    );

  if (!deudores.length) {
    await sendMessage(
      chatId,
      `✅ Revisé ${entornos.length} entornos: nadie tiene saldo pendiente.`,
    );
    return;
  }

  const total = deudores.reduce((acc, d) => acc + d.cobro!.saldoPendiente, 0);
  const lines = [
    `💰 <b>${deudores.length} con saldo pendiente</b> · total $${total.toFixed(2)}`,
    `<i>Revisé ${entornos.length} entornos.</i>`,
    "",
  ];
  for (const { entorno, cobro } of deudores) {
    lines.push(
      `${cobro!.vencidas ? "🔴" : "🟡"} <b>${escapeHtml(entorno.nombre)}</b>${entorno.activo ? "" : " · inactivo"}: $${cobro!.saldoPendiente.toFixed(2)}${
        cobro!.vencidas ? ` · ${cobro!.vencidas} vencida${cobro!.vencidas === 1 ? "" : "s"}` : ""
      }`,
    );
  }

  const keyboard: TgInlineKeyboard = deudores
    .filter((d) => d.cobro!.stripeActivo)
    .slice(0, 20)
    .map((d) => [
      { text: `💳 ${d.entorno.nombre.slice(0, 40)}`, callback_data: `pagar:${d.entorno.id}` },
    ]);

  await sendMessage(chatId, lines.join("\n"), keyboard);
}

function textoFactura(f: FacturaAbierta): string {
  return `${periodoLegible(f.periodo)}${f.etiqueta ? ` (${f.etiqueta})` : ""}`;
}

/**
 * Botón "Generar link de pago". Con una factura abierta genera el link al
 * tiro; con varias pregunta cuál (o todas, una detrás de otra).
 */
export async function pedirLinkDePago(operator: OperatorDoc, workspaceId: string): Promise<void> {
  const chatId = operator.telegramChatId;
  const cobro = await cobroDeEntorno(workspaceId);
  if (!cobro || !cobro.facturas.length) {
    await sendMessage(chatId, "Ese cliente ya no tiene saldo pendiente 👌");
    return;
  }
  if (cobro.facturas.length === 1) {
    await enviarLinkDePago(operator, workspaceId, cobro.facturas[0].id);
    return;
  }
  await sendMessage(
    chatId,
    `<b>${escapeHtml(cobro.cliente)}</b> tiene ${cobro.facturas.length} facturas abiertas. Cuál cobramos?`,
    cobro.facturas.map((f) => [
      {
        text: `${f.estado === "overdue" ? "🔴" : "🟡"} ${textoFactura(f)} · $${f.saldo.toFixed(2)}`,
        callback_data: `pagarf:${workspaceId}:${f.id}`,
      },
    ]),
  );
}

/** Genera el link de Stripe y le da al asesor el mensaje listo para mandar. */
export async function enviarLinkDePago(
  operator: OperatorDoc,
  workspaceId: string,
  invoiceId: string,
): Promise<void> {
  const chatId = operator.telegramChatId;
  await sendTyping(chatId);
  const [cobro, entorno] = await Promise.all([
    cobroDeEntorno(workspaceId),
    entornoPorId(workspaceId),
  ]);
  const factura = cobro?.facturas.find((f) => f.id === invoiceId);
  if (!cobro || !factura) {
    await sendMessage(chatId, "Esa factura ya no tiene saldo pendiente 👌");
    return;
  }

  const url = await linkDePago(workspaceId, invoiceId);
  const nombre = entorno?.nombre || cobro.cliente;
  const mensaje = `Te dejo el link para ponerte al día con ${textoFactura(factura)} ($${factura.saldo.toFixed(
    2,
  )}). Se paga con tarjeta en un minuto y queda registrado solito:\n${url}\nCualquier cosa me avisas y lo vemos.`;

  await sendMessage(
    chatId,
    [
      `💳 <b>Link de pago listo</b> · ${escapeHtml(nombre)}`,
      `${escapeHtml(textoFactura(factura))} · <b>$${factura.saldo.toFixed(2)}</b>${
        factura.estado === "overdue" ? " · vencida" : ""
      }`,
      "",
      "<b>Mensaje para el cliente</b> (toca para copiar):",
      `<code>${escapeHtml(mensaje)}</code>`,
      "",
      "<b>Solo el link:</b>",
      `<code>${escapeHtml(url)}</code>`,
      "",
      "<i>El link cobra solo lo que falta de esa factura y se registra solo en finanzas al pagar.</i>",
    ].join("\n"),
  );
}

export function cobrosDisponibles(): boolean {
  return Boolean(env.METRICS_DB_URI) && financesConfigurado();
}
