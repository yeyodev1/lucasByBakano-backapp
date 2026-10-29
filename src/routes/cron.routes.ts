import { Router } from "express";
import * as cronController from "../controllers/cron.controller";

const router = Router();

// Sin authMiddleware: se autentica con CRON_SECRET dentro del controller.
router.get("/lucas", cronController.lucas);
router.get("/revision-diaria", cronController.revisionDiaria);

export default router;
