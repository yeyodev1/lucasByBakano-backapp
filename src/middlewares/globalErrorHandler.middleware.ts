import { Request, Response, NextFunction } from "express";
import { ErrorHandler } from "../errors/errorHandler.error";
import { env } from "../config/env";

export function globalErrorHandler(error: any, _req: Request, res: Response, _next: NextFunction) {
  const handler = new ErrorHandler(env.SLACK_ERROR_WEBHOOK);

  // Índice único de Mongo: es un 409 del cliente, no un 500 nuestro.
  if (error?.code === 11000) {
    const duplicatedField = Object.keys(error.keyValue || {})[0] || "campo";
    const duplicatedValue = error.keyValue?.[duplicatedField];
    res.status(409).json({
      message: duplicatedValue
        ? `Ya existe un registro con ${duplicatedField}: ${duplicatedValue}`
        : "Ya existe un registro con esos datos",
    });
    return;
  }

  if (error?.message === "Not allowed by CORS") {
    res.status(403).json({ message: "Origen no permitido por CORS" });
    return;
  }

  const status = error.status || 500;
  const message = error.message || "Internal Server Error";

  handler.handleHttpError(res, message, status, error);
}
