import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";

/** Solo cuentas de administración. Va siempre después de authMiddleware. */
export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.accountType !== "admin") {
    res.status(403).json({ message: "No tienes permiso para ver esto" });
    return;
  }
  next();
}
