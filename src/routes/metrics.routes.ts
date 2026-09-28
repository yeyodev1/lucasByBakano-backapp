import { Router } from "express";
import * as metricsController from "../controllers/metrics.controller";

const router = Router();

// Sin authMiddleware: se autentica con la llave compartida dentro del controller.
router.get("/entornos/:workspaceId/resumen", metricsController.resumenEntorno);

export default router;
