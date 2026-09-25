import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { CustomError } from "../errors/customError.error";
import * as settingService from "../services/setting.service";

/** GET /api/settings/business */
export async function getBusinessSetting(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const value = await settingService.getSetting(settingService.BUSINESS_KEY);
    res.status(200).json({ key: settingService.BUSINESS_KEY, value });
  } catch (error) {
    next(error);
  }
}

/** PUT /api/settings/business — body: { value } */
export async function setBusinessSetting(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { value } = req.body ?? {};
    if (typeof value !== "string") throw new CustomError("El valor debe ser un texto", 400);
    const author = req.user?.email ?? "admin";
    const saved = await settingService.setSetting(settingService.BUSINESS_KEY, value, author);
    res.status(200).json({ key: settingService.BUSINESS_KEY, value: saved });
  } catch (error) {
    next(error);
  }
}
