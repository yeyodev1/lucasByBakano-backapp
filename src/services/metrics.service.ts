import mongoose, { Connection, Types } from "mongoose";
import { env } from "../config/env";
import { normalizePhone } from "../models/client.model";
import type { ClientDoc } from "./client.service";

/**
 * Lectura de Metrics (metrics-bakano-backapp): ahí vive el "entorno"
 * (workspace) de cada cliente de Bakano. Lucas lo consulta para saber si la
 * persona ya es cliente activo, si se fue (y por qué) o si es un prospecto.
 *
 * Solo lectura: se usa un usuario de Atlas con rol read y aquí solo hay
 * find(). Si METRICS_DB_URI no está, Lucas funciona igual sin este contexto.
 */

let conexion: Promise<Connection> | null = null;

function conectar(): Promise<Connection> {
  conexion ??= mongoose
    .createConnection(env.METRICS_DB_URI, {
      dbName: env.METRICS_DB_NAME,
      serverSelectionTimeoutMS: 8000,
      readPreference: "secondaryPreferred",
    })
    .asPromise()
    .catch((error) => {
      conexion = null;
      throw error;
    });
  return conexion;
}

const MOTIVOS_DESACTIVACION: Record<string, string> = {
  falta_de_pago: "falta de pago",
  fin_de_contrato: "fin de contrato",
  pausa_acordada: "pausa acordada",
  otro: "otro motivo",
};

export interface EntornoMetrics {
  id: string;
  nombre: string;
  activo: boolean;
  desde: Date | null;
  desactivacion: string;
  vertical: string;
  descripcion: string;
  ticketPromedio: string;
  metaConectado: boolean;
  onboarding: string;
  animoBot: string;
  // Lo que ya hizo el bot de Bakano (@BakanoAgencyBot) con este cliente: Lucas
  // lo lee para no repetir ni contradecir lo que el cliente ya recibió.
  bot: {
    recordoPagoEn: Date | null;
    alertoEquipoEn: Date | null;
    alertaEstado: string;
    ultimosMensajes: { rol: "cliente" | "bot"; texto: string; en: Date }[];
  };
  // Cómo se encontró: por teléfono o correo es seguro; por nombre, hay que confirmar.
  coincidencia: "telegram" | "telefono" | "correo" | "nombre";
}

export interface ContextoMetrics {
  estado: "no_configurado" | "error" | "sin_entorno" | "encontrado";
  entornos: EntornoMetrics[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resumenOnboarding(workspace: any): string {
  const sesiones = workspace.onboardingSesiones ?? {};
  const partes = ["bienvenida", "especializacion", "levantamiento"]
    .filter((k) => sesiones[k])
    .map((k) => `${k}: ${sesiones[k].estado ?? (sesiones[k].agendada ? "agendada" : "pendiente")}`);
  return partes.join(", ");
}

/** Busca el entorno del cliente en Metrics por Telegram, teléfono, correo o nombre. */
export async function contextoDeCliente(client: ClientDoc): Promise<ContextoMetrics> {
  if (!env.METRICS_DB_URI) return { estado: "no_configurado", entornos: [] };

  try {
    const db = (await conectar()).db!;
    const users = db.collection("users");
    const workspaces = db.collection("workspaces");
    const chats = db.collection("telegramchats");

    const encontrados = new Map<string, EntornoMetrics["coincidencia"]>();
    const anotar = (id: unknown, como: EntornoMetrics["coincidencia"]) => {
      if (id && !encontrados.has(String(id))) encontrados.set(String(id), como);
    };
    const animoPorEntorno = new Map<string, string>();

    if (client.telegramUserId) {
      const chat = await chats.findOne(
        { telegramUserId: client.telegramUserId },
        { projection: { workspaceId: 1, ultimoAnimo: 1 } },
      );
      anotar(chat?.workspaceId, "telegram");
    }

    const condiciones: Record<string, unknown>[] = [];
    for (const phone of client.phones) {
      const ultimos = normalizePhone(phone).slice(-9);
      if (ultimos.length >= 7)
        condiciones.push({ phoneNumber: { $regex: escapeRegex(ultimos) + "$" } });
    }
    if (client.email) condiciones.push({ email: client.email.toLowerCase() });

    if (condiciones.length) {
      const usuarios = await users
        .find(
          { $or: condiciones, isInternal: { $ne: true } },
          { projection: { email: 1, phoneNumber: 1, workspaceId: 1, workspaces: 1 } },
        )
        .limit(5)
        .toArray();
      for (const u of usuarios) {
        const como = client.email && u.email === client.email.toLowerCase() ? "correo" : "telefono";
        anotar(u.workspaceId, como);
        for (const acceso of u.workspaces ?? []) anotar(acceso.workspaceId, como);
      }
    }

    // Último recurso: el nombre de la empresa coincide con el del entorno.
    if (!encontrados.size && client.company.trim().length >= 4) {
      const porNombre = await workspaces
        .find(
          { name: { $regex: `^${escapeRegex(client.company.trim())}$`, $options: "i" } },
          { projection: { _id: 1 } },
        )
        .limit(3)
        .toArray();
      for (const w of porNombre) anotar(w._id, "nombre");
    }

    if (!encontrados.size) return { estado: "sin_entorno", entornos: [] };

    const ids = [...encontrados.keys()].map((id) => new Types.ObjectId(id));
    const [docs, animos, chatsBot] = await Promise.all([
      workspaces
        .find(
          { _id: { $in: ids } },
          {
            projection: {
              name: 1,
              isActive: 1,
              createdAt: 1,
              desactivacion: 1,
              "brandProfile.vertical": 1,
              "brandProfile.descripcion": 1,
              "brandProfile.ticketPromedio": 1,
              "metaAds.pageName": 1,
              onboardingSesiones: 1,
            },
          },
        )
        .toArray(),
      chats
        .find(
          { workspaceId: { $in: ids }, ultimoAnimo: { $exists: true } },
          { projection: { workspaceId: 1, ultimoAnimo: 1 } },
        )
        .sort({ "ultimoAnimo.en": -1 })
        .limit(10)
        .toArray(),
      chats
        .find(
          { workspaceId: { $in: ids } },
          {
            projection: {
              workspaceId: 1,
              avisoPagoEn: 1,
              ultimaAlerta: 1,
              historial: { $slice: -6 },
              updatedAt: 1,
            },
          },
        )
        .sort({ updatedAt: -1 })
        .limit(10)
        .toArray(),
    ]);
    const botPorEntorno = new Map<string, EntornoMetrics["bot"]>();
    for (const c of chatsBot) {
      const key = String(c.workspaceId);
      const previo = botPorEntorno.get(key);
      const actual: EntornoMetrics["bot"] = {
        recordoPagoEn: c.avisoPagoEn ?? null,
        alertoEquipoEn: c.ultimaAlerta?.en ?? null,
        alertaEstado: c.ultimaAlerta?.estado ?? "",
        ultimosMensajes: (c.historial ?? []).map((m: any) => ({
          rol: m.rol === "cliente" ? "cliente" : "bot",
          texto: String(m.texto ?? "").slice(0, 400),
          en: m.en,
        })),
      };
      // Varios chats del mismo entorno (dueño y colaboradores): se juntan.
      if (!previo) botPorEntorno.set(key, actual);
      else {
        const masReciente = (a: Date | null, b: Date | null) =>
          !a ? b : !b ? a : new Date(a) > new Date(b) ? a : b;
        previo.recordoPagoEn = masReciente(previo.recordoPagoEn, actual.recordoPagoEn);
        if (masReciente(previo.alertoEquipoEn, actual.alertoEquipoEn) === actual.alertoEquipoEn) {
          previo.alertoEquipoEn = actual.alertoEquipoEn;
          previo.alertaEstado = actual.alertaEstado || previo.alertaEstado;
        }
      }
    }
    for (const c of animos) {
      const key = String(c.workspaceId);
      if (!animoPorEntorno.has(key) && c.ultimoAnimo?.estado) {
        animoPorEntorno.set(
          key,
          `${c.ultimoAnimo.estado}${c.ultimoAnimo.motivo ? ` (${c.ultimoAnimo.motivo})` : ""}`,
        );
      }
    }

    const entornos: EntornoMetrics[] = docs.map((w: any) => ({
      id: String(w._id),
      nombre: w.name ?? "",
      activo: Boolean(w.isActive),
      desde: w.createdAt ?? null,
      desactivacion:
        w.isActive || !w.desactivacion
          ? ""
          : [
              MOTIVOS_DESACTIVACION[w.desactivacion.motivo] ?? w.desactivacion.motivo,
              w.desactivacion.nota,
            ]
              .filter(Boolean)
              .join(": "),
      vertical: w.brandProfile?.vertical ?? "",
      descripcion: String(w.brandProfile?.descripcion ?? "").slice(0, 400),
      ticketPromedio: w.brandProfile?.ticketPromedio ?? "",
      metaConectado: Boolean(w.metaAds?.pageName),
      onboarding: resumenOnboarding(w),
      animoBot: animoPorEntorno.get(String(w._id)) ?? "",
      bot: botPorEntorno.get(String(w._id)) ?? {
        recordoPagoEn: null,
        alertoEquipoEn: null,
        alertaEstado: "",
        ultimosMensajes: [],
      },
      coincidencia: encontrados.get(String(w._id)) ?? "nombre",
    }));

    return { estado: "encontrado", entornos };
  } catch (error: any) {
    console.error("[metrics] no se pudo consultar:", error?.message ?? error);
    return { estado: "error", entornos: [] };
  }
}

/** Todos los entornos de Metrics (para revisar quién debe). */
export async function listarEntornos(): Promise<{ id: string; nombre: string; activo: boolean }[]> {
  if (!env.METRICS_DB_URI) return [];
  const db = (await conectar()).db!;
  const docs = await db
    .collection("workspaces")
    .find({}, { projection: { name: 1, isActive: 1 } })
    .toArray();
  return docs.map((w: any) => ({
    id: String(w._id),
    nombre: w.name ?? "",
    activo: Boolean(w.isActive),
  }));
}

/** Nombre y estado de un entorno por id. */
export async function entornoPorId(
  id: string,
): Promise<{ id: string; nombre: string; activo: boolean } | null> {
  if (!env.METRICS_DB_URI || !Types.ObjectId.isValid(id)) return null;
  const db = (await conectar()).db!;
  const w = await db
    .collection("workspaces")
    .findOne({ _id: new Types.ObjectId(id) }, { projection: { name: 1, isActive: 1 } });
  return w ? { id, nombre: w.name ?? "", activo: Boolean(w.isActive) } : null;
}
