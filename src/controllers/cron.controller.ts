import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import * as monitorService from "../services/monitor.service";

/** GET /api/cron/lucas — Vercel Cron manda Authorization: Bearer CRON_SECRET. */
export async function lucas(req: Request, res: Response, next: NextFunction) {
  try {
    if (!env.CRON_SECRET || req.header("authorization") !== `Bearer ${env.CRON_SECRET}`) {
      res.status(401).json({ message: "No autorizado" });
      return;
    }
    const resultado = await monitorService.revisarSinRespuesta();
    res.status(200).json(resultado);
  } catch (error) {
    next(error);
  }
}
