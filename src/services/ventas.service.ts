import { Types } from "mongoose";
import { Client } from "../models/client.model";
import { leadsCalientes } from "./client.service";
import { facturacionDeEntorno } from "./metrics.service";
import { getNegocio } from "./negocio.service";
import { escapeHtml, sendMessage, sendTyping } from "./telegram.service";
import { barraCierre, temperaturaLabel } from "./recommendation.service";
import { TgInlineKeyboard } from "../types/telegram";

function dolares(monto: number): string {
  return `$${monto.toLocaleString("es-EC", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/**
 * /ventas: cómo va el mes del negocio. Junta lo que registró en Metrics
 * (su facturación diaria) con lo que Lucas ve en sus chats: ventas cerradas
 * y leads que todavía se pueden cerrar.
 */
export async function resumenVentas(chatId: number, negocioId: Types.ObjectId): Promise<void> {
  await sendTyping(chatId);
  const negocio = await getNegocio(negocioId);
  if (!negocio) return;

  const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [facturacion, cerradas, calientes] = await Promise.all([
    negocio.workspaceId ? facturacionDeEntorno(negocio.workspaceId) : Promise.resolve(null),
    Client.countDocuments({ negocio: negocioId, stage: "cliente", updatedAt: { $gte: inicioMes } }),
    leadsCalientes(negocioId, 5),
  ]);

  const lines = [`📊 <b>Cómo va ${escapeHtml(negocio.nombre)} este mes</b>`, ""];

  if (facturacion) {
    const { mesActual, mesAnterior, diasSinRegistrar, ultimos7 } = facturacion;
    lines.push(`💵 Facturado este mes: <b>${dolares(mesActual.total)}</b>`);
    if (mesAnterior.total > 0) {
      const cambio = Math.round(((mesActual.total - mesAnterior.total) / mesAnterior.total) * 100);
      lines.push(
        `El mes pasado cerraste en ${dolares(mesAnterior.total)} (${cambio >= 0 ? "+" : ""}${cambio}% hasta hoy)`,
      );
    }
    lines.push(`Últimos 7 días: ${dolares(ultimos7)}`);
    if (mesActual.metaSpend > 0) {
      lines.push(
        `Invertido en Meta: ${dolares(mesActual.metaSpend)} · ROAS ${(mesActual.total / mesActual.metaSpend).toFixed(1)}`,
      );
    }
    if (diasSinRegistrar > 0) {
      lines.push(
        `⚠️ Te faltan <b>${diasSinRegistrar}</b> día${diasSinRegistrar === 1 ? "" : "s"} por registrar en Metrics: sin eso el ROAS no es real.`,
      );
    }
  } else {
    lines.push(
      negocio.workspaceId
        ? "Todavía no veo tu facturación en Metrics."
        : "Tu negocio no está enlazado a Metrics: pídele a tu asesor que lo enlace para ver tu facturación aquí.",
    );
  }

  lines.push("", `✅ Ventas que marcaste como cerradas en Lucas: <b>${cerradas}</b>`);

  const keyboard: TgInlineKeyboard = [];
  if (calientes.length) {
    lines.push("", "🔥 <b>Lo que todavía puedes cerrar</b>");
    for (const l of calientes) {
      lines.push(
        `${temperaturaLabel(l.cierre.temperatura)} · ${escapeHtml(l.name)} · ${barraCierre(l.cierre.probabilidad)}`,
      );
      keyboard.push([{ text: `💡 ${l.name.slice(0, 40)}`, callback_data: `sug:${l._id}` }]);
    }
  }
  await sendMessage(chatId, lines.join("\n"), keyboard);
}
