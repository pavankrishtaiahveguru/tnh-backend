import { Router } from "express";
import { interact } from "../controllers/aiAgentController.js";

const router = Router();

router.post("/interact", interact);

export default router;
