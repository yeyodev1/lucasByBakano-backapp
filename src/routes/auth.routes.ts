import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import * as authController from "../controllers/auth.controller";

const router = Router();

router.post("/login", authController.login);

router.use(authMiddleware);

router.get("/me", authController.me);
router.put("/password", authController.changePassword);

export default router;
