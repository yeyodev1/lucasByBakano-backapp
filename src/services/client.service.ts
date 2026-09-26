import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import {
  Client,
  CLIENT_STAGES,
  ClientStage,
  IClient,
  normalizeName,
  normalizePhone,
} from "../models/client.model";

export type ClientDoc = IClient & { _id: Types.ObjectId };

export interface ClientIdentity {
  name?: string;
  phone?: string;
  email?: string;
  telegramUserId?: number | null;
  telegramUsername?: string;
}

export interface ResolveResult {
  client: ClientDoc | null;
  created: boolean;
  // Varios clientes con el mismo nombre: el operador tiene que elegir.
  candidates: ClientDoc[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isValidStage(stage: string): stage is ClientStage {
  return (CLIENT_STAGES as readonly string[]).includes(stage);
}

/**
 * Con negocioId, el lead tiene que ser de ese negocio: un botón o un id
 * reenviado nunca abre el lead de otro negocio.
 */
export async function getClientById(
  id: string | Types.ObjectId,
  negocioId?: Types.ObjectId | null,
): Promise<ClientDoc> {
  if (!Types.ObjectId.isValid(String(id))) throw new CustomError("Cliente no válido", 400);
  const filter: Record<string, unknown> = { _id: id };
  if (negocioId) filter.negocio = negocioId;
  const client = await Client.findOne(filter).lean<ClientDoc>();
  if (!client) throw new CustomError("Cliente no encontrado", 404);
  return client;
}

/** Busca por teléfono, @usuario, correo o nombre (sin tildes). */
export async function searchClients(
  query: string,
  negocioId: Types.ObjectId,
  limit = 8,
): Promise<ClientDoc[]> {
  const q = query.trim();
  if (!q) return [];

  const or: Record<string, unknown>[] = [];
  const digits = normalizePhone(q);
  if (digits.length >= 6) or.push({ phones: { $regex: escapeRegex(digits.slice(-9)) + "$" } });
  if (q.startsWith("@")) or.push({ telegramUsername: q.slice(1).toLowerCase() });
  if (q.includes("@") && !q.startsWith("@")) or.push({ email: q.toLowerCase() });
  or.push({ searchName: { $regex: escapeRegex(normalizeName(q)) } });

  return Client.find({ negocio: negocioId, $or: or })
    .sort({ lastContactAt: -1, updatedAt: -1 })
    .limit(limit)
    .lean<ClientDoc[]>();
}

export async function listClients(params: {
  q?: string;
  stage?: string;
  page?: number;
  negocio?: string;
}) {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = 25;
  const filter: Record<string, unknown> = {};
  if (params.negocio && Types.ObjectId.isValid(params.negocio)) filter.negocio = params.negocio;
  if (params.stage && isValidStage(params.stage)) filter.stage = params.stage;
  if (params.q?.trim()) filter.searchName = { $regex: escapeRegex(normalizeName(params.q)) };

  const [items, total] = await Promise.all([
    Client.find(filter)
      .sort({ lastContactAt: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<ClientDoc[]>(),
    Client.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function createClient(
  data: Partial<IClient> & { name: string; negocio: Types.ObjectId },
): Promise<ClientDoc> {
  const name = data.name?.trim();
  if (!name) throw new CustomError("El cliente necesita un nombre", 400);
  if (!data.negocio) throw new CustomError("El lead necesita un negocio", 400);
  if (data.stage && !isValidStage(data.stage)) throw new CustomError("Etapa no válida", 400);

  const client = await Client.create({
    ...data,
    name,
    phones: (data.phones ?? []).map(normalizePhone).filter(Boolean),
    telegramUsername: data.telegramUsername?.replace(/^@/, "") ?? "",
  });
  return client.toObject() as ClientDoc;
}

const EDITABLE_FIELDS = [
  "name",
  "phones",
  "email",
  "company",
  "telegramUserId",
  "telegramUsername",
  "stage",
  "source",
  "interests",
  "tags",
  "summary",
] as const;

export async function updateClient(
  id: string | Types.ObjectId,
  patch: Partial<IClient>,
): Promise<ClientDoc> {
  const client = await Client.findById(id);
  if (!client) throw new CustomError("Cliente no encontrado", 404);
  if (patch.stage && !isValidStage(patch.stage)) throw new CustomError("Etapa no válida", 400);

  for (const field of EDITABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === "phones") {
      client.phones = (patch.phones ?? []).map(normalizePhone).filter(Boolean);
    } else if (field === "telegramUsername") {
      client.telegramUsername = String(patch.telegramUsername ?? "").replace(/^@/, "");
    } else {
      client.set(field, patch[field]);
    }
  }
  await client.save();
  return client.toObject() as ClientDoc;
}

export async function deleteClient(id: string): Promise<void> {
  const result = await Client.deleteOne({ _id: id });
  if (!result.deletedCount) throw new CustomError("Cliente no encontrado", 404);
}

export async function addNote(
  id: string | Types.ObjectId,
  text: string,
  author: string,
): Promise<ClientDoc> {
  if (!text.trim()) throw new CustomError("La nota está vacía", 400);
  const client = await Client.findByIdAndUpdate(
    id,
    { $push: { notes: { text: text.trim(), author, createdAt: new Date() } } },
    { new: true },
  ).lean<ClientDoc>();
  if (!client) throw new CustomError("Cliente no encontrado", 404);
  return client;
}

export async function touchLastContact(id: Types.ObjectId, at: Date): Promise<void> {
  await Client.updateOne(
    { _id: id, $or: [{ lastContactAt: null }, { lastContactAt: { $lt: at } }] },
    { $set: { lastContactAt: at } },
  );
}

/**
 * Encuentra al cliente con lo que se sepa de él, en orden de confianza:
 * id de Telegram → teléfono → @usuario → correo → nombre exacto.
 * Si no aparece y hay nombre, lo crea como lead.
 */
export async function resolveClient(
  identity: ClientIdentity,
  options: { createIfMissing: boolean; source?: string; negocioId: Types.ObjectId },
): Promise<ResolveResult> {
  const found = await findByIdentity(identity, options.negocioId);
  if (found.client || found.candidates.length) return { ...found, created: false };

  const name = identity.name?.trim();
  if (!options.createIfMissing || !name) return { client: null, created: false, candidates: [] };

  const client = await createClient({
    negocio: options.negocioId,
    name,
    phones: identity.phone ? [identity.phone] : [],
    email: identity.email ?? "",
    telegramUserId: identity.telegramUserId ?? null,
    telegramUsername: identity.telegramUsername ?? "",
    source: options.source ?? "",
  });
  return { client, created: true, candidates: [] };
}

async function findByIdentity(
  identity: ClientIdentity,
  negocioId: Types.ObjectId,
): Promise<{ client: ClientDoc | null; candidates: ClientDoc[] }> {
  if (identity.telegramUserId) {
    const client = await Client.findOne({
      negocio: negocioId,
      telegramUserId: identity.telegramUserId,
    }).lean<ClientDoc>();
    if (client) return { client, candidates: [] };
  }
  if (identity.phone) {
    const digits = normalizePhone(identity.phone);
    if (digits.length >= 6) {
      const client = await Client.findOne({
        negocio: negocioId,
        phones: { $regex: escapeRegex(digits.slice(-9)) + "$" },
      }).lean<ClientDoc>();
      if (client) return { client, candidates: [] };
    }
  }
  if (identity.telegramUsername) {
    const client = await Client.findOne({
      negocio: negocioId,
      telegramUsername: identity.telegramUsername.replace(/^@/, "").toLowerCase(),
    }).lean<ClientDoc>();
    if (client) return { client, candidates: [] };
  }
  if (identity.email) {
    const client = await Client.findOne({
      negocio: negocioId,
      email: identity.email.toLowerCase(),
    }).lean<ClientDoc>();
    if (client) return { client, candidates: [] };
  }
  if (identity.name?.trim()) {
    const matches = await Client.find({
      negocio: negocioId,
      searchName: normalizeName(identity.name),
    })
      .limit(5)
      .lean<ClientDoc[]>();
    if (matches.length === 1) return { client: matches[0], candidates: [] };
    if (matches.length > 1) return { client: null, candidates: matches };
  }
  return { client: null, candidates: [] };
}

export interface CapturedData {
  name?: string;
  phone?: string;
  email?: string;
  company?: string;
  interests?: string[];
}

/**
 * Completa la ficha con lo que Lucas leyó en la conversación. Solo llena
 * campos vacíos o suma datos nuevos: nunca pisa lo que el equipo escribió.
 */
export async function applyCapturedData(
  id: Types.ObjectId,
  data: CapturedData,
  extra: {
    summary?: string;
    stage?: string;
    cierre?: { probabilidad: number; temperatura: string; falta: string[] };
  },
): Promise<string[]> {
  const client = await Client.findById(id);
  if (!client) return [];
  const changes: string[] = [];

  const phone = data.phone ? normalizePhone(data.phone) : "";
  if (phone.length >= 7 && !client.phones.includes(phone)) {
    client.phones.push(phone);
    changes.push(`teléfono ${phone}`);
  }
  if (data.email && !client.email) {
    client.email = data.email.toLowerCase();
    changes.push(`correo ${client.email}`);
  }
  if (data.company && !client.company) {
    client.company = data.company;
    changes.push(`empresa ${data.company}`);
  }
  for (const interest of data.interests ?? []) {
    const clean = interest.trim();
    if (clean && !client.interests.some((i: string) => normalizeName(i) === normalizeName(clean))) {
      client.interests.push(clean);
      changes.push(`interés "${clean}"`);
    }
  }
  if (extra.summary) client.summary = extra.summary;
  if (extra.cierre) client.set("cierre", { ...extra.cierre, en: new Date() });
  // La etapa solo avanza sola desde "lead": moverla después es decisión del equipo.
  if (
    extra.stage &&
    isValidStage(extra.stage) &&
    client.stage === "lead" &&
    extra.stage !== "lead"
  ) {
    client.stage = extra.stage;
    changes.push(`etapa → ${extra.stage}`);
  }

  await client.save();
  return changes;
}

/** Leads del negocio ordenados por qué tan cerca están de cerrar (últimos 14 días). */
export async function leadsCalientes(negocioId: Types.ObjectId, limit = 10): Promise<ClientDoc[]> {
  return Client.find({
    negocio: negocioId,
    stage: { $nin: ["cliente", "perdido"] },
    "cierre.en": { $gt: new Date(Date.now() - 14 * 24 * 3_600_000) },
  })
    .sort({ "cierre.probabilidad": -1, lastContactAt: -1 })
    .limit(limit)
    .lean<ClientDoc[]>();
}
