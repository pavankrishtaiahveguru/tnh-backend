import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  deleteMedia,
  uploadImage,
  uploadVideo,
} from "../controllers/uploadController.js";

const router = Router();
function handleUpload(fieldName, maxSize, controller) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSize },
  });
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (error) => {
      if (error instanceof multer.MulterError) {
        const message =
          error.code === "LIMIT_FILE_SIZE"
            ? fieldName === "image"
              ? "Image size is too large. Please upload an image smaller than or equal to 5 MB."
              : "Video size is too large."
            : `Invalid ${fieldName} upload.`;
        return res.status(400).json({ success: false, message });
      }
      if (error) return next(error);
      return controller(req, res);
    });
  };
}

router.post(
  "/image",
  authMiddleware,
  handleUpload("image", 5 * 1024 * 1024, uploadImage),
);
router.post(
  "/video",
  authMiddleware,
  handleUpload("video", 250 * 1024 * 1024, uploadVideo),
);
router.delete("/media", authMiddleware, deleteMedia);

export default router;
