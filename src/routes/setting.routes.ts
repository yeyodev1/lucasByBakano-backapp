import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import * as settingController from "../controllers/setting.controller";

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get("/business", settingController.getBusinessSetting);
router.put("/business", settingController.setBusinessSetting);

export default router;
