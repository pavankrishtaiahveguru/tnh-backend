import { Router } from "express";
import {
  getBranches,
  updateExistingBranch,
} from "../controllers/branchController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

router.get("/", getBranches);
router.put("/:id", authMiddleware, updateExistingBranch);

export default router;
