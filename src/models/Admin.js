// ==================================================
// Admin model — raw SQL queries against the `admins` table
// ==================================================
import pool from "../config/database.js";

// Returns the full admin row (including password_hash) or null.
// Only for internal use (login flow) — never send this row directly
// to the client.
export async function findAdminByEmail(email) {
  const [rows] = await pool.query(
    "SELECT id, name, email, password_hash, role, is_active, created_at, updated_at FROM admins WHERE email = ? LIMIT 1",
    [email]
  );
  return rows[0] ?? null;
}

// Returns the full admin row by id (including password_hash) or null.
export async function findAdminById(id) {
  const [rows] = await pool.query(
    "SELECT id, name, email, password_hash, role, is_active, created_at, updated_at FROM admins WHERE id = ? LIMIT 1",
    [id]
  );
  return rows[0] ?? null;
}

// Creates a new admin row. Expects an already-hashed password.
export async function createAdmin({ name, email, passwordHash, role = "admin" }) {
  const [result] = await pool.query(
    "INSERT INTO admins (name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?) RETURNING id",
    [name, email, passwordHash, role, true]
  );
  return result.insertId;
}

// Strips password_hash before the record ever leaves the service layer.
export function toPublicAdmin(admin) {
  if (!admin) return null;
  const { password_hash, ...publicAdmin } = admin;
  return publicAdmin;
}
