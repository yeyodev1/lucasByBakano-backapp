import mongoose from "mongoose";
import { env } from "./env";

/**
 * Conexión a Mongo pensada para serverless.
 *
 * Se guarda la *promesa* de conexión a nivel de módulo: las invocaciones que
 * reusan la instancia esperan la misma promesa en vez de abrir otra conexión
 * (Atlas tiene un tope) y ninguna consulta corre antes de tiempo.
 *
 * Una conexión fallida no se cachea: si se guardara, la instancia quedaría
 * inservible hasta que Vercel la recicle.
 */

let promesa: Promise<typeof mongoose> | null = null;

/** 1 = conectado. */
export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function dbConnect(): Promise<boolean> {
  if (isConnected()) return true;

  if (!promesa) {
    promesa = mongoose.connect(env.DB_URI, {
      // Fallar rápido y reintentar es mejor que dejar la petición colgada.
      serverSelectionTimeoutMS: 8000,
      // Sin buffer, una consulta lanzada antes de tiempo falla en vez de
      // quedarse esperando en silencio.
      bufferCommands: false,
    });
  }

  try {
    await promesa;
    console.log("Connected to MongoDB");
    return true;
  } catch (error) {
    promesa = null;
    console.error("MongoDB connection error:", error);
    if (!env.IS_VERCEL) process.exit(1);
    return false;
  }
}
