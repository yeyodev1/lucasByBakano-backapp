import { Request, Response } from "express";
import { env } from "../config/env";
import * as lucasService from "../services/lucas.service";
import { TgUpdate } from "../types/telegram";

/**
 * POST /api/telegram/webhook — updates de Telegram.
 *
 * Se procesa antes de responder porque en Vercel la función se congela al
 * enviar la respuesta. Siempre se contesta 200: un error devuelto haría que
 * Telegram reintente el mismo update en bucle.
 */
export async function webhook(req: Request, res: Response) {
  const secret = req.header("x-telegram-bot-api-secret-token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(401).json({ message: "No autorizado" });
    return;
  }

  const update = req.body as TgUpdate;
  if (typeof update?.update_id !== "number") {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    await lucasService.handleUpdate(update);
  } catch (error) {
    console.error("[telegram] error procesando update", update.update_id, error);
  }
  res.status(200).json({ ok: true });
}
