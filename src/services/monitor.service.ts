import { Types } from "mongoose";
import { env } from "../config/env";
import { Client } from "../models/client.model";
import { Conversation } from "../models/conversation.model";
import { Message } from "../models/message.model";
import { avisarEquipo } from "./alert.service";
import { hallazgosDesde } from "./metrics.service";

/**
 * Revisa los chats reales (Telegram Business) y avisa al equipo cuando un
 * cliente escribió y nadie le respondió en LUCAS_SLA_MINUTOS. Corre por cron
 * en Vercel y cada pocos minutos en modo polling.
 */

function horaEcuador(fecha = new Date()): number {
  return Number(
    fecha.toLocaleString("en-US", {
      timeZone: "America/Guayaquil",
      hour: "numeric",
      hour12: false,
    }),
  );
}

function tiempoLegible(ms: number): string {
  const minutos = Math.round(ms / 60_000);
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas} h${minutos % 60 ? ` ${minutos % 60} min` : ""}`;
  const dias = Math.floor(horas / 24);
  return `${dias} día${dias === 1 ? "" : "s"}`;
}

export async function revisarSinRespuesta(): Promise<{ revisadas: number; avisos: number }> {
  // De noche no se molesta a nadie: lo que llegue se avisa a primera hora.
  const hora = horaEcuador();
  if (hora < 8 || hora >= 20) return { revisadas: 0, avisos: 0 };

  const ahora = Date.now();
  const limite = new Date(ahora - env.LUCAS_SLA_MINUTOS * 60_000);
  const desde = new Date(ahora - 3 * 24 * 3_600_000);

  const conversaciones = await Conversation.find({
    channel: "telegram_business",
    lastMessageAt: { $lt: limite, $gt: desde },
  })
    .select("_id client lastMessageAt")
    .lean<{ _id: Types.ObjectId; client: Types.ObjectId }[]>();

  let avisos = 0;
  for (const conversacion of conversaciones) {
    const ultimo = await Message.findOne({ conversation: conversacion._id })
      .sort({ sentAt: -1 })
      .lean<{ _id: Types.ObjectId; sender: string; text: string; sentAt: Date }>();
    if (!ultimo || ultimo.sender !== "cliente") continue;

    const cliente = await Client.findById(conversacion.client)
      .select("name")
      .lean<{ _id: Types.ObjectId; name: string }>();
    if (!cliente) continue;

    const espera = ahora - new Date(ultimo.sentAt).getTime();
    const enviado = await avisarEquipo({
      clientId: cliente._id,
      clientName: cliente.name,
      category: "sin_respuesta",
      level: espera > 4 * 3_600_000 ? "urgente" : "aviso",
      text: `Escribió hace ${tiempoLegible(espera)} y nadie le ha respondido:\n"${ultimo.text.slice(0, 250)}"`,
      // Un aviso por mensaje sin responder, no uno cada vez que corre el cron.
      dedupeKey: `sin_respuesta:${ultimo._id}`,
    });
    if (enviado) avisos++;
  }
  return { revisadas: conversaciones.length, avisos };
}

const TIPOS: Record<string, string> = {
  cierre_casi_solo: "🎯 Cierre casi solo",
  lead_sin_respuesta: "⏰ Lead sin respuesta",
  oportunidad_estancada: "🧊 Oportunidad estancada",
};

/**
 * La revisión diaria del CRM (en Metrics) deja hallazgos por cliente. Lucas
 * le pasa al equipo un resumen por cliente y por día para que den
 * seguimiento; el bot de Bakano ya se lo dijo al cliente.
 */
export async function avisarHallazgosCrm(): Promise<number> {
  const hallazgos = await hallazgosDesde(new Date(Date.now() - 36 * 3_600_000));
  const porEntorno = new Map<string, typeof hallazgos>();
  for (const h of hallazgos) {
    const clave = `${h.workspaceId}:${h.dia}`;
    porEntorno.set(clave, [...(porEntorno.get(clave) ?? []), h]);
  }

  let avisos = 0;
  for (const [clave, lista] of porEntorno) {
    const [workspaceId] = clave.split(":");
    const cierres = lista.filter((h) => h.tipo === "cierre_casi_solo").length;
    const lineas = lista.map((h) =>
      [
        `${TIPOS[h.tipo] ?? h.tipo} · ${h.contacto.nombre || "sin nombre"}${h.contacto.telefono ? ` (${h.contacto.telefono})` : ""}${h.monto ? ` · $${h.monto}` : ""}`,
        `  ${h.resumen}`,
        h.queHacer && `  → ${h.queHacer}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const avisado = lista.some((h) => h.avisadoClienteEn);
    const enviado = await avisarEquipo({
      clientId: null,
      clientName: lista[0].entorno,
      category: "oportunidad",
      level: cierres >= 2 ? "urgente" : "aviso",
      text: [
        `Su CRM muestra ${lista.length} lead${lista.length === 1 ? "" : "s"} que se le fue${lista.length === 1 ? "" : "ron"} ayer${cierres ? `, ${cierres} era${cierres === 1 ? "" : "n"} cierre casi solo` : ""}:`,
        "",
        ...lineas,
        "",
        avisado
          ? "El bot de Bakano ya se lo avisó al cliente con el link a Bakanology. Denle seguimiento para que tome el curso de ventas."
          : "Todavía no se le avisó al cliente: díganselo y recomiéndenle el curso de ventas de Bakanology.",
      ].join("\n"),
      dedupeKey: `crm:${clave}`,
      keyboard: [
        [
          {
            text: "🔌 Ver su CRM en Metrics",
            url: `${env.METRICS_APP_URL}/app/workspaces/${workspaceId}/integraciones`,
          },
        ],
      ],
    });
    if (enviado) avisos++;
  }
  return avisos;
}
