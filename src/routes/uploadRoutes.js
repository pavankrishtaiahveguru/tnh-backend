import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { uploadImage } from "../controllers/uploadController.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (file.mimetype?.startsWith("image/")) {
      callback(null, true);
    } else {
      callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "image"));
    }
  },
});

router.post("/image", authMiddleware, (req, res, next) => {
  upload.single("image")(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "Image size is too large."
          : "Invalid image format.";
      return res.status(400).json({ success: false, message });
    }
    if (error) return next(error);
    return uploadImage(req, res);
  });
});

export default router;
