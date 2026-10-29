import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import * as monitorService from "../services/monitor.service";
import { correrRevisionDiaria, diaEcuador } from "../services/revisionDiaria.service";

/** GET /api/cron/lucas — Vercel Cron manda Authorization: Bearer CRON_SECRET. */
export async function lucas(req: Request, res: Response, next: NextFunction) {
  try {
    if (!env.CRON_SECRET || req.header("authorization") !== `Bearer ${env.CRON_SECRET}`) {
      res.status(401).json({ message: "No autorizado" });
      return;
    }
    const resultado = await monitorService.revisarSinRespuesta();
    const avisosCrm = await monitorService.avisarHallazgosCrm();
    res.status(200).json({ ...resultado, avisosCrm });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/cron/revision-diaria — 21:00 a 22:45 de Ecuador cada 15 min.
 * Revisa las conversaciones del día y, completa, la manda a Metrics, que la
 * envía a Dirección por @BakanoAgencyBot. Cada corrida sigue donde quedó.
 */
export async function revisionDiaria(req: Request, res: Response, next: NextFunction) {
  try {
    if (!env.CRON_SECRET || req.header("authorization") !== `Bearer ${env.CRON_SECRET}`) {
      res.status(401).json({ message: "No autorizado" });
      return;
    }
    res.status(200).json(await correrRevisionDiaria(diaEcuador()));
  } catch (error) {
    next(error);
  }
}
