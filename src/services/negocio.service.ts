import crypto from "crypto";
import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Negocio, NegocioDoc } from "../models/negocio.model";
import { PerfilNegocio, perfilDeEntorno } from "./metrics.service";

function nuevoCodigo(nombre: string): string {
  const base = nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 10);
  return `${base || "negocio"}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function crearNegocio(params: {
  nombre: string;
  workspaceId?: string;
  creadoPor: string;
}): Promise<NegocioDoc> {
  const nombre = params.nombre.trim();
  if (!nombre) throw new CustomError("El negocio necesita un nombre", 400);
  const negocio = await Negocio.create({
    nombre,
    workspaceId: params.workspaceId ?? "",
    codigo: nuevoCodigo(nombre),
    creadoPor: params.creadoPor,
  });
  return negocio.toObject() as NegocioDoc;
}

export async function getNegocio(id: Types.ObjectId | string | null): Promise<NegocioDoc | null> {
  if (!id || !Types.ObjectId.isValid(String(id))) return null;
  return Negocio.findById(id).lean<NegocioDoc>();
}

export async function negocioPorCodigo(codigo: string): Promise<NegocioDoc | null> {
  if (!codigo.trim()) return null;
  return Negocio.findOne({
    codigo: codigo.trim().toLowerCase(),
    isActive: true,
  }).lean<NegocioDoc>();
}

export async function negocioPorEntorno(workspaceId: string): Promise<NegocioDoc | null> {
  if (!workspaceId) return null;
  return Negocio.findOne({ workspaceId, isActive: true }).lean<NegocioDoc>();
}

export async function listarNegocios(): Promise<NegocioDoc[]> {
  return Negocio.find({ isActive: true }).sort({ nombre: 1 }).lean<NegocioDoc[]>();
}

export async function actualizarNegocio(
  id: Types.ObjectId,
  patch: Partial<Pick<NegocioDoc, "info" | "datosPago" | "alertChatId" | "workspaceId" | "nombre">>,
): Promise<void> {
  await Negocio.updateOne({ _id: id }, { $set: patch });
}

export async function agregarRegla(id: Types.ObjectId, regla: string): Promise<string[]> {
  const limpia = regla.trim();
  if (!limpia) throw new CustomError("La regla está vacía", 400);
  const negocio = await Negocio.findByIdAndUpdate(
    id,
    { $push: { reglas: limpia } },
    { new: true },
  ).lean<NegocioDoc>();
  return negocio?.reglas ?? [];
}

export async function quitarRegla(id: Types.ObjectId, indice: number): Promise<string[]> {
  const negocio = await Negocio.findById(id);
  if (!negocio || indice < 0 || indice >= negocio.reglas.length) {
    throw new CustomError("No encontré esa regla", 404);
  }
  negocio.reglas.splice(indice, 1);
  await negocio.save();
  return negocio.reglas;
}

export interface ContextoNegocio {
  negocio: NegocioDoc;
  perfil: PerfilNegocio | null;
}

/** Todo lo que Lucas necesita saber del negocio para recomendar. */
export async function contextoDeNegocio(id: Types.ObjectId | null): Promise<ContextoNegocio> {
  const negocio = await getNegocio(id);
  if (!negocio)
    throw new CustomError("No estás vinculado a ningún negocio. Usa /vincular <código>.", 403);
  const perfil = negocio.workspaceId ? await perfilDeEntorno(negocio.workspaceId) : null;
  return { negocio, perfil };
}
