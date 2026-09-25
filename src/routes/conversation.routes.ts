import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import * as conversationController from "../controllers/conversation.controller";

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get("/:id", conversationController.getConversation);

export default router;
