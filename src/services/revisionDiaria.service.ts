import { Types } from "mongoose";
import { Conversation } from "../models/conversation.model";
import { Message } from "../models/message.model";
import { Client } from "../models/client.model";
import { Negocio } from "../models/negocio.model";
import { Suggestion } from "../models/suggestion.model";
import { RevisionDiaria } from "../models/revisionDiaria.model";
import { concluirDia, revisarConversacionDelDia } from "./ai.service";
import { aprendizajesVigentes, enviarRevisionDiaria } from "./metrics.service";

/**
 * Revisión de fin de día (pedido de Diego 2026-10-29): cada conversación del
 * día de cada negocio con quién atendió al lead, cómo, si estuvo bien o mal,
 * por qué, qué debió hacerse y si se usó lo que Lucas propuso. Al cerrar,
 * propone reglas para que Lucas recomiende mejor y lo manda todo a Metrics,
 * que lo envía a Dirección por @BakanoAgencyBot y Slack. Las reglas que
 * Dirección aprueba vuelven a Lucas (`aprendizajesAprobados`).
 *
 * Corre a las 21:00 de Ecuador en varias corridas: RevisionDiaria guarda el
 * avance y es el candado.
 */

const PRESUPUESTO_MS = 240_000;
const LOTE = 4;

/** Hoy en Ecuador (UTC-5 todo el año), AAAA-MM-DD. */
export function diaEcuador(ahora = new Date()): string {
  return new Date(ahora.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

function rangoDia(dia: string): { desde: Date; hasta: Date } {
  const desde = new Date(`${dia}T05:00:00Z`);
  return { desde, hasta: new Date(desde.getTime() + 86_400_000) };
}

/** Conversaciones con algún mensaje del lead en el día, de negocios activos. */
async function conversacionesDelDia(dia: string) {
  const { desde, hasta } = rangoDia(dia);
  const ids: Types.ObjectId[] = await Message.distinct("conversation", { sender: "cliente", sentAt: { $gte: desde, $lt: hasta } });
  if (!ids.length) return [];
  const conversaciones: any[] = await Conversation.find({ _id: { $in: ids } }).lean();
  const clientes: any[] = await Client.find({ _id: { $in: conversaciones.map((c) => c.client) } }).select("name negocio").lean();
  const negocios: any[] = await Negocio.find({ _id: { $in: clientes.map((c) => c.negocio) }, isActive: true }).select("nombre").lean();
  const clienteDe = new Map(clientes.map((c) => [String(c._id), c]));
  const negocioDe = new Map(negocios.map((n) => [String(n._id), n.nombre as string]));
  return conversaciones
    .map((c) => {
      const cliente = clienteDe.get(String(c.client));
      const negocio = cliente && negocioDe.get(String(cliente.negocio));
      return negocio ? { conversation: c, lead: cliente.name as string, negocio } : null;
    })
    .filter(Boolean) as { conversation: any; lead: string; negocio: string }[];
}

async function evaluar(c: { conversation: any; lead: string; negocio: string }, dia: string) {
  const { desde, hasta } = rangoDia(dia);
  const [messages, sugerencias] = await Promise.all([
    Message.find({ conversation: c.conversation._id, sentAt: { $gte: desde, $lt: hasta } }).sort({ sentAt: 1 }).lean(),
    Suggestion.find({ conversation: c.conversation._id, createdAt: { $gte: desde, $lt: hasta } })
      .select("replies chosenReply createdAt")
      .lean(),
  ]);
  const r = await revisarConversacionDelDia({
    negocio: c.negocio,
    lead: c.lead,
    current: { conversation: c.conversation, messages: messages as any },
    sugerencias: (sugerencias as any[]).map((s) => ({
      hora: s.createdAt,
      respuestas: (s.replies ?? []).map((x: any) => String(x.text ?? "")),
      elegida: s.chosenReply ?? null,
    })),
  });
  return { conversacionId: c.conversation._id, negocio: c.negocio, lead: c.lead, mensajes: messages.length, ...r };
}

/** Una corrida del cron: evalúa lo que falte y, cuando ya no falta nada, envía. */
export async function correrRevisionDiaria(dia = diaEcuador()): Promise<{ dia: string; revisadas: number; faltan: number; enviada: boolean }> {
  const limite = Date.now() + PRESUPUESTO_MS;
  const revision: any = await RevisionDiaria.findOneAndUpdate(
    { dia },
    { $setOnInsert: { dia, estado: "en_curso", conversaciones: [], fallidas: [] } },
    { upsert: true, new: true },
  );
  if (revision.estado === "enviada") return { dia, revisadas: revision.conversaciones.length, faltan: 0, enviada: true };

  const todas = await conversacionesDelDia(dia);
  const hechas = new Set([...revision.conversaciones.map((c: any) => String(c.conversacionId)), ...revision.fallidas.map(String)]);
  const faltan = todas.filter((c) => !hechas.has(String(c.conversation._id)));

  for (let i = 0; i < faltan.length && Date.now() < limite; i += LOTE) {
    const lote = faltan.slice(i, i + LOTE);
    const r = await Promise.allSettled(lote.map((c) => evaluar(c, dia)));
    const ok = r.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
    const fallidas = lote.filter((_, j) => r[j]!.status === "rejected").map((c) => c.conversation._id);
    r.forEach((x, j) => x.status === "rejected" && console.error(`[revisión diaria] ${lote[j]!.negocio}:`, (x.reason as any)?.message ?? x.reason));
    await RevisionDiaria.updateOne({ _id: revision._id }, { $push: { conversaciones: { $each: ok } }, $addToSet: { fallidas: { $each: fallidas } } });
    lote.forEach((c) => hechas.add(String(c.conversation._id)));
  }
  const pendientes = todas.filter((c) => !hechas.has(String(c.conversation._id))).length;
  if (pendientes || Date.now() > limite) return { dia, revisadas: hechas.size, faltan: pendientes, enviada: false };

  // Candado del envío: una sola corrida concluye y manda.
  const cierre: any = await RevisionDiaria.findOneAndUpdate({ _id: revision._id, estado: "en_curso" }, { $set: { estado: "enviada" } }, { new: true }).lean();
  if (!cierre) return { dia, revisadas: hechas.size, faltan: 0, enviada: true };
  if (!cierre.conversaciones.length) {
    await RevisionDiaria.updateOne({ _id: cierre._id }, { $set: { enviadaEn: new Date() } });
    return { dia, revisadas: 0, faltan: 0, enviada: true };
  }

  const conProblema = cierre.conversaciones.filter((c: any) => c.calificacion !== "bien");
  const { conclusion, aprendizajes } = conProblema.length
    ? await concluirDia({ dia, conversaciones: conProblema, reglasExistentes: await aprendizajesVigentes().catch(() => []) }).catch((e) => {
        console.error("[revisión diaria] conclusión:", e?.message ?? e);
        return { conclusion: "No se pudo armar la conclusión del día.", aprendizajes: [] };
      })
    : { conclusion: "Todas las conversaciones del día estuvieron bien atendidas.", aprendizajes: [] };

  const enviada = await enviarRevisionDiaria({
    dia,
    conversaciones: cierre.conversaciones.map((c: any) => ({
      conversacionId: String(c.conversacionId),
      negocio: c.negocio,
      cliente: c.lead,
      mensajes: c.mensajes,
      quienAtendio: c.quienAtendio,
      resumen: c.resumen,
      comoAtendio: c.comoAtendio,
      calificacion: c.calificacion,
      porque: c.porque,
      debioHacer: c.debioHacer,
      usoLucas: c.usoLucas,
    })),
    conclusion,
    aprendizajes,
  });
  // Si Metrics no respondió, se reabre para que la siguiente corrida lo intente.
  await RevisionDiaria.updateOne({ _id: cierre._id }, enviada ? { $set: { enviadaEn: new Date() } } : { $set: { estado: "en_curso" } });
  return { dia, revisadas: cierre.conversaciones.length, faltan: 0, enviada };
}
