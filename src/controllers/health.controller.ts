import { Request, Response, NextFunction } from "express";
import { isConnected } from "../config/mongo";

/** GET /api/health — estado del proceso y de la base. */
export function status(_req: Request, res: Response, next: NextFunction) {
  try {
    const db = isConnected();
    res.status(db ? 200 : 503).json({
      ok: db,
      db: db ? "connected" : "disconnected",
      uptime: Math.round(process.uptime()),
    });
  } catch (error) {
    next(error);
  }
}
