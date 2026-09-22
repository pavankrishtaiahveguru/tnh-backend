// ==================================================
// TNH Salon backend — server entry point
// ==================================================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { testConnection } from "./config/database.js";
import authRoutes from "./routes/authRoutes.js";
import serviceRoutes from "./routes/serviceRoutes.js";
import categoryRoutes from "./routes/categoryRoutes.js";
import branchRoutes from "./routes/branchRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import catalogRoutes from "./routes/catalogRoutes.js";
import aiAgentRoutes from "./routes/aiAgentRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// ---- Core middleware ----
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  }),
);
app.use(express.json());

// ---- Health check ----
app.get("/health", (req, res) => {
  res
    .status(200)
    .json({ success: true, message: "TNH Salon backend is running" });
});

// ---- Routes ----
app.use("/api/auth", authRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/branches", branchRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/catalog", catalogRoutes);
app.use("/api/ai-agent", aiAgentRoutes);

// ---- 404 handler ----
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ---- Centralized error handler ----
// Catches anything thrown/passed to next(err) that wasn't already handled by
// a route. Never leaks SQL, stack traces, or secrets to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

async function start() {
  try {
    await testConnection();
  } catch (error) {
    console.error("Failed to connect to the database:", error.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log("========================================");
    console.log("✓ TNH SALON BACKEND");
    console.log("========================================");
    console.log("");
    console.log("✓ PostgreSQL (Neon) connection established");
    console.log(`✓ Server running: http://localhost:${PORT}`);
    console.log("");
    console.log("========================================");
    console.log("✓ Backend is Running Successfully");
    console.log("========================================");
  });
}

start();
