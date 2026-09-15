// ==================================================
// JWT auth middleware — protects routes with Authorization: Bearer <token>
// Reusable as-is for future modules (categories, services, branches, bookings).
// ==================================================
import { verifyAdminToken } from "../services/authService.js";

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const decoded = verifyAdminToken(token);
    req.user = {
      adminId: decoded.adminId,
      role: decoded.role,
    };
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
}

export default authMiddleware;
