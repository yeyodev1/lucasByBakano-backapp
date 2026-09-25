import { Router } from "express";
import * as telegramController from "../controllers/telegram.controller";

const router = Router();

// Sin authMiddleware: Telegram se autentica con el header secret_token.
router.post("/webhook", telegramController.webhook);

export default router;
