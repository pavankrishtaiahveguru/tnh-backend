// ==================================================
// Service routes — mounted at /api/services (JWT-protected)
// ==================================================
import { Router } from "express";
import {
  getServices,
  getServicesCount,
  getService,
  createNewService,
  updateExistingService,
  updateExistingServiceStatus,
  removeService,
} from "../controllers/serviceController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

router.get("/", getServices);
// Declared before /:id so "count" is not captured as an id param.
router.get("/count", getServicesCount);
router.get("/:id", getService);

router.use(authMiddleware);

router.post("/", createNewService);
router.put("/:id", updateExistingService);
router.patch("/:id/status", updateExistingServiceStatus);
router.delete("/:id", removeService);

export default router;
