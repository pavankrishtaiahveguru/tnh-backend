// ==================================================
// Auth controller — request/response handling for /api/auth
// ==================================================
import { loginAdmin, getAdminProfile, InvalidCredentialsError } from "../services/authService.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateLoginInput(email, password) {
  if (!email || !password) {
    return "Email and password are required";
  }
  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    return "A valid email is required";
  }
  if (typeof password !== "string") {
    return "A valid password is required";
  }
  return null;
}

export async function login(req, res) {
  try {
    const { email, password } = req.body ?? {};

    const validationError = validateLoginInput(email, password);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const { token, admin } = await loginAdmin(email.trim().toLowerCase(), password);

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      admin,
    });
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      return res.status(401).json({ success: false, message: error.message });
    }

    console.error("Login error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}

export async function getMe(req, res) {
  try {
    const admin = await getAdminProfile(req.user.adminId);

    if (!admin) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    return res.status(200).json({ success: true, admin });
  } catch (error) {
    console.error("Get current admin error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
}
