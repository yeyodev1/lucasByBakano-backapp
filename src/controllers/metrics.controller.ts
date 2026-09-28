import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { Types } from "mongoose";
import { env } from "../config/env";
import * as resumenMetricsService from "../services/resumenMetrics.service";

function llaveValida(recibida: string | undefined): boolean {
  const esperada = env.METRICS_SYNC_KEY;
  if (!esperada || !recibida) return false;
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET /api/metrics/entornos/:workspaceId/resumen?dias=30 — servidor a
 * servidor: el MCP de Metrics lo pide con la misma llave (x-metrics-key) que
 * Lucas ya usa para escribirle a Metrics.
 */
export async function resumenEntorno(req: Request, res: Response, next: NextFunction) {
  try {
    if (!llaveValida(req.header("x-metrics-key"))) {
      res.status(401).json({ message: "Llave inválida" });
      return;
    }
    const workspaceId = String(req.params.workspaceId || "");
    if (!Types.ObjectId.isValid(workspaceId)) {
      res.status(400).json({ message: "Entorno inválido" });
      return;
    }
    const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 90);
    res.status(200).json(await resumenMetricsService.resumenDeEntorno(workspaceId, dias));
  } catch (error) {
    next(error);
  }
}
