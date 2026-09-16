// ==================================================
// Catalog routes — reference-format Excel export/import (JWT-protected)
// ==================================================
import { Router } from "express";
import multer from "multer";
import {
  exportCatalogExcel,
  importCatalogExcel,
} from "../controllers/catalogController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

// .xlsx uploads only, capped at 10 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    const name = file.originalname?.toLowerCase() ?? "";
    if (
      name.endsWith(".xlsx") ||
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      return callback(null, true);
    }
    callback(null, false);
  },
});

// The whole module is admin-only — the export contains the full catalogue.
router.use(authMiddleware);

router.get("/export", exportCatalogExcel);
router.post("/import", upload.single("file"), importCatalogExcel);

export default router;
