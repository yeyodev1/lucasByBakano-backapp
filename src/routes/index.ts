import express, { Application } from "express";
import authRoutes from "./auth.routes";
import healthRoutes from "./health.routes";
import telegramRoutes from "./telegram.routes";
import clientRoutes from "./client.routes";
import conversationRoutes from "./conversation.routes";
import settingRoutes from "./setting.routes";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/health", healthRoutes);
  router.use("/auth", authRoutes);
  router.use("/telegram", telegramRoutes);
  router.use("/clients", clientRoutes);
  router.use("/conversations", conversationRoutes);
  router.use("/settings", settingRoutes);
}

export default routerApi;
