import express, { Application } from "express";
import authRoutes from "./auth.routes";
import healthRoutes from "./health.routes";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/health", healthRoutes);
  router.use("/auth", authRoutes);
}

export default routerApi;
