// ==================================================
// Catalog routes — export/import of the salon catalog (JWT-protected)
// ==================================================
import { Router } from "express";
import multer from "multer";
import {
  exportCatalogJson,
  importCatalogFile,
} from "../controllers/catalogController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

// Legacy .json file uploads, capped at 10 MB. (The Admin Excel import flow
// sends parsed JSON instead — multer simply passes that request through.)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (
      file.mimetype === "application/json" ||
      file.originalname?.toLowerCase().endsWith(".json")
    ) {
      return callback(null, true);
    }
    callback(null, false);
  },
});

// The whole module is admin-only — exports contain the full catalog.
router.use(authMiddleware);

router.get("/export", exportCatalogJson);
router.post("/import", upload.single("file"), importCatalogFile);

export default router;
