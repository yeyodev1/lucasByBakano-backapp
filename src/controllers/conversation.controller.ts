import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as conversationService from "../services/conversation.service";

/** GET /api/conversations/:id — devuelve { conversation, messages } */
export async function getConversation(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const result = await conversationService.getConversation(id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
