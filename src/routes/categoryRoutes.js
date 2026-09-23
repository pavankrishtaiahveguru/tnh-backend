// ==================================================
// Category routes — mounted at /api/categories (JWT-protected)
// ==================================================
import { Router } from "express";
import {
  getCategories,
  getCategory,
  createNewCategory,
  updateExistingCategory,
  removeCategory,
  reorderCategory,
  reorderCategorySubCategories,
} from "../controllers/categoryController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

router.get("/", getCategories);
router.get("/:id", getCategory);

router.use(authMiddleware);

router.post("/", createNewCategory);
router.put("/:id", updateExistingCategory);
router.patch("/:id/order", reorderCategory);
router.put("/:categoryId/subcategories/reorder", reorderCategorySubCategories);
router.delete("/:id", removeCategory);

export default router;
