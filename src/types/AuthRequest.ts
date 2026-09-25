import { Request } from "express";

export interface JwtPayload {
  userId: string;
  email: string;
  accountType: string;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}
