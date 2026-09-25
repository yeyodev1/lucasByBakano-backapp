import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { CustomError } from "../errors/customError.error";
import * as authService from "../services/auth.service";

/** POST /api/auth/login — body: { email, password } */
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body ?? {};
    const result = await authService.login(String(email ?? ""), String(password ?? ""));
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/** GET /api/auth/me — devuelve la sesión del token. */
export async function me(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new CustomError("No autorizado", 401);
    const user = await authService.findById(req.user.userId);
    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/auth/password — body: { current, next } */
export async function changePassword(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new CustomError("No autorizado", 401);
    const { current, next: nueva } = req.body ?? {};
    const user = await authService.changePassword(
      req.user.userId,
      String(current ?? ""),
      String(nueva ?? ""),
    );
    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
}
