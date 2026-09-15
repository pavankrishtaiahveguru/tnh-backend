// ==================================================
// Admin seeder — creates the first admin from .env values
// Run with: npm run seed:admin
// ==================================================
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import pool, { testConnection } from "../config/database.js";
import { findAdminByEmail, createAdmin } from "../models/Admin.js";

dotenv.config();

const SALT_ROUNDS = 10;

async function seedAdmin() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
    process.exitCode = 1;
    return;
  }

  try {
    await testConnection();

    const email = ADMIN_EMAIL.trim().toLowerCase();
    const existingAdmin = await findAdminByEmail(email);

    if (existingAdmin) {
      console.log(`Admin with email "${email}" already exists. Skipping.`);
      return;
    }

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
    const insertId = await createAdmin({
      name: ADMIN_NAME,
      email,
      passwordHash,
      role: "admin",
    });

    console.log(`Admin created successfully (id: ${insertId}, email: ${email}).`);
  } catch (error) {
    console.error("Failed to seed admin:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seedAdmin();
