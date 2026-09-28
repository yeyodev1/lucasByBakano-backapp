import { Types } from "mongoose";
import { Negocio } from "../models/negocio.model";
import { Operator } from "../models/operator.model";
import { Client } from "../models/client.model";
import { Suggestion } from "../models/suggestion.model";
import { Alert } from "../models/alert.model";
import { Conversation } from "../models/conversation.model";

const DIA = 86_400_000;

function recortar(texto: string | undefined, max = 280): string | undefined {
  if (!texto) return undefined;
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

/**
 * Lo que el equipo de Bakano necesita saber desde el MCP de Metrics: si el
 * cliente ya usa a Lucas, quién lo usa, si le hace caso (elige las respuestas
 * que sugiere) y cómo van sus ventas. Solo lectura y sin textos de mensajes:
 * los resúmenes que ya escribió Lucas alcanzan para saber cómo va.
 */
export async function resumenDeEntorno(workspaceId: string, dias = 30) {
  const negocios = await Negocio.find({ workspaceId }).lean<any[]>();
  if (!negocios.length) return { usaLucas: false as const };

  const desde = new Date(Date.now() - dias * DIA);
  const semana = new Date(Date.now() - 7 * DIA);
  const ids = negocios.map((n) => n._id as Types.ObjectId);

  const [operadores, clientesIds] = await Promise.all([
    Operator.find({ negocio: { $in: ids } }).select("name username role isActive createdAt").lean<any[]>(),
    Client.find({ negocio: { $in: ids } }).distinct("_id"),
  ]);

  const [porEtapa, nuevos, recientes, sugerencias, ultimaSugerencia, alertas, conversaciones] = await Promise.all([
    Client.aggregate([{ $match: { negocio: { $in: ids } } }, { $group: { _id: "$stage", n: { $sum: 1 } } }]),
    Client.countDocuments({ negocio: { $in: ids }, createdAt: { $gte: desde } }),
    Client.find({ negocio: { $in: ids }, lastContactAt: { $gte: desde } })
      .sort({ lastContactAt: -1 })
      .limit(10)
      .select("name stage summary cierre lastContactAt")
      .lean<any[]>(),
    Suggestion.aggregate([
      { $match: { client: { $in: clientesIds }, createdAt: { $gte: desde } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          semana: { $sum: { $cond: [{ $gte: ["$createdAt", semana] }, 1, 0] } },
          eligioRespuesta: { $sum: { $cond: [{ $ne: ["$chosenReply", null] }, 1, 0] } },
        },
      },
    ]),
    Suggestion.findOne({ client: { $in: clientesIds } }).sort({ createdAt: -1 }).select("createdAt").lean<any>(),
    Alert.find({ negocio: { $in: ids }, createdAt: { $gte: desde } })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("client", "name")
      .select("category level text createdAt client")
      .lean<any[]>(),
    Conversation.countDocuments({ client: { $in: clientesIds }, lastMessageAt: { $gte: desde } }),
  ]);

  // El último paso que Lucas recomendó para cada lead reciente.
  const pasos = await Suggestion.aggregate([
    { $match: { client: { $in: recientes.map((c) => c._id) } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$client", nextStep: { $first: "$nextStep" }, en: { $first: "$createdAt" } } },
  ]);
  const pasoDe = new Map(pasos.map((p: any) => [String(p._id), p]));
  const s = sugerencias[0] ?? { total: 0, semana: 0, eligioRespuesta: 0 };

  return {
    usaLucas: true as const,
    dias,
    negocios: negocios.map((n) => ({
      nombre: n.nombre,
      activo: n.isActive !== false,
      desde: n.createdAt,
      configurado: { queVende: Boolean(n.info?.trim()), datosPago: Boolean(n.datosPago?.trim()), reglas: n.reglas?.length ?? 0 },
    })),
    quienesLoUsan: operadores.map((o) => ({ nombre: o.name, usuario: o.username, rol: o.role, activo: o.isActive !== false, desde: o.createdAt })),
    uso: {
      lecturasEnElPeriodo: s.total,
      lecturasUltimaSemana: s.semana,
      eligioUnaRespuestaSugerida: s.eligioRespuesta,
      ultimaVez: ultimaSugerencia?.createdAt ?? null,
      conversacionesActivas: conversaciones,
    },
    leads: {
      total: porEtapa.reduce((t: number, e: any) => t + e.n, 0),
      porEtapa: Object.fromEntries(porEtapa.map((e: any) => [e._id, e.n])),
      nuevosEnElPeriodo: nuevos,
      recientes: recientes.map((c) => ({
        nombre: c.name,
        etapa: c.stage,
        temperatura: c.cierre?.temperatura || undefined,
        probabilidad: c.cierre?.probabilidad || undefined,
        falta: c.cierre?.falta?.length ? c.cierre.falta : undefined,
        resumen: recortar(c.summary),
        siguientePaso: recortar(pasoDe.get(String(c._id))?.nextStep, 200),
        ultimoContacto: c.lastContactAt,
      })),
    },
    alertas: alertas.map((a) => ({ categoria: a.category, nivel: a.level, texto: recortar(a.text, 240), lead: a.client?.name, en: a.createdAt })),
  };
}
