// ==================================================
// Auth service — password checks, JWT issuing/verification
// ==================================================
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { findAdminByEmail, findAdminById, toPublicAdmin } from "../models/Admin.js";

// Generic error used for both "email not found" and "wrong password" so the
// controller never has to decide how much detail to leak.
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}

export function signAdminToken(admin) {
  const payload = {
    adminId: admin.id,
    role: admin.role,
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "1d",
  });
}

export function verifyAdminToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

// Full login flow: lookup -> active check -> password compare -> token.
// Throws InvalidCredentialsError for any failure that should be reported to
// the client as a generic "invalid email or password" — this intentionally
// covers "email not found" and "account inactive" so existence of an email
// is never revealed.
export async function loginAdmin(email, password) {
  const admin = await findAdminByEmail(email);

  if (!admin) {
    throw new InvalidCredentialsError();
  }

  if (!admin.is_active) {
    throw new InvalidCredentialsError();
  }

  const passwordMatches = await bcrypt.compare(password, admin.password_hash);
  if (!passwordMatches) {
    throw new InvalidCredentialsError();
  }

  const token = signAdminToken(admin);
  return { token, admin: toPublicAdmin(admin) };
}

// Used by GET /api/auth/me — resolves the authenticated admin's public
// profile from the id embedded in the JWT payload.
export async function getAdminProfile(adminId) {
  const admin = await findAdminById(adminId);
  if (!admin || !admin.is_active) {
    return null;
  }
  return toPublicAdmin(admin);
}
