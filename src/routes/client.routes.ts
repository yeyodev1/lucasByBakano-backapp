import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import * as clientController from "../controllers/client.controller";

const router = Router();

router.use(authMiddleware);
router.use(adminMiddleware);

router.get("/search", clientController.searchClients);
router.get("/", clientController.listClients);
router.post("/", clientController.createClient);
router.get("/:id", clientController.getClient);
router.patch("/:id", clientController.updateClient);
router.delete("/:id", clientController.deleteClient);
router.post("/:id/notes", clientController.addNote);
router.get("/:id/conversations", clientController.listClientConversations);

export default router;
