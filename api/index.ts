import "dotenv/config";
import type { Express } from "express";
import { dbConnect, isConnected } from "../src/config/mongo";
import { createApp } from "../src/app";
import { seedAdmin } from "../src/services/auth.service";

/**
 * Entrada para Vercel.
 *
 * El arranque se guarda como promesa, no como bandera: dos peticiones que
 * lleguen juntas a una instancia fría entrarían las dos al arranque y se
 * atenderían antes de que Mongo terminara de conectar.
 *
 * Además se reintenta la conexión en cada invocación si se cayó, porque una
 * instancia puede sobrevivir a la conexión que tenía.
 */
let arranque: Promise<Express> | null = null;

async function ensureApp(): Promise<Express> {
  if (!arranque) {
    arranque = (async () => {
      await dbConnect();
      await seedAdmin();
      return createApp().app;
    })().catch((error) => {
      // No se cachea un arranque fallido: la siguiente petición reintenta.
      arranque = null;
      throw error;
    });
  }

  const app = await arranque;

  if (!isConnected()) {
    const reconectado = await dbConnect();
    if (reconectado) await seedAdmin();
  }

  return app;
}

export default async function handler(req: any, res: any) {
  try {
    const application = await ensureApp();
    application(req, res);
  } catch (error) {
    console.error("[api] no se pudo iniciar la aplicación:", error);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Servicio no disponible. Intenta de nuevo." }));
  }
}
