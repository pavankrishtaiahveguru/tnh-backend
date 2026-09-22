// ==================================================
// One-time admin credential sync — updates the EXISTING admin record in the
// `admins` table to match ADMIN_EMAIL / ADMIN_PASSWORD from .env
// Run with: node scripts/updateAdminCredentials.mjs
// (or: npm run admin:sync-credentials)
// ==================================================
// Safety rules enforced by this script:
//   - Never prints the password or password hash.
//   - Password is hashed with bcryptjs @ 10 rounds — the SAME algorithm and
//     configuration the app uses (src/seed/adminSeeder.js, and verified with
//     bcrypt.compare in src/services/authService.js). Never stored plaintext.
//   - Updates ONLY the existing admin row — never inserts a duplicate.
//   - Refuses to overwrite another account if ADMIN_EMAIL already belongs to
//     one, and refuses to guess when the update target is ambiguous.
//   - All SQL is parameterized; email + password update runs in a transaction
//     and verifies exactly one row was affected.
//   - Closes the database pool before exiting.
// ==================================================
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import pool, { testConnection } from "../src/config/database.js";

dotenv.config();

// Same configuration as the admin seeder — login verifies with
// bcrypt.compare, so the hash MUST stay compatible with it.
const SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  }

  // Login normalizes emails with trim().toLowerCase() before lookup, so the
  // stored email is normalized the same way here.
  const newEmail = ADMIN_EMAIL.trim().toLowerCase();
  if (!EMAIL_REGEX.test(newEmail)) {
    throw new Error("ADMIN_EMAIL in .env is not a valid email address");
  }

  await testConnection();

  // ---- Locate the existing admin record (id + email only — never selects
  // password_hash; hashing is done fresh from the new .env value) ----
  const [adminRows] = await pool.query(
    "SELECT id, email FROM admins ORDER BY id ASC"
  );

  if (adminRows.length === 0) {
    throw new Error(
      "No admin records found. Run `npm run seed:admin` first — this script only updates an EXISTING admin."
    );
  }

  const matchingEmail = adminRows.find((row) => row.email === newEmail);

  let target;
  let updateEmail;
  if (matchingEmail) {
    // ADMIN_EMAIL already belongs to this admin — only the password changes.
    target = matchingEmail;
    updateEmail = false;
  } else if (adminRows.length === 1) {
    // Unambiguous: the single existing admin gets the new email + password.
    target = adminRows[0];
    updateEmail = true;
  } else {
    // Multiple admins and none matches ADMIN_EMAIL — refuse to guess which
    // record to modify instead of risking an update to the wrong user.
    throw new Error(
      `Multiple admin records exist (${adminRows.length}) and none matches ADMIN_EMAIL. Update the intended record manually instead of running this script.`
    );
  }

  // ---- Conflict guard: never overwrite a DIFFERENT account's email ----
  if (updateEmail) {
    const [conflicts] = await pool.query(
      "SELECT id FROM admins WHERE email = ? AND id <> ? LIMIT 1",
      [newEmail, target.id]
    );
    if (conflicts.length > 0) {
      throw new Error(
        `Conflict: ADMIN_EMAIL already belongs to another account (id: ${conflicts[0].id}). No changes were made.`
      );
    }
  }

  // ---- Hash the new password (never logged, never persisted plaintext) ----
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);

  // Self-check before writing: the freshly generated hash must verify against
  // the new password with the same bcrypt.compare call the login flow uses.
  // Purely in-memory — nothing is printed either way except pass/fail.
  const hashVerifies = await bcrypt.compare(ADMIN_PASSWORD, passwordHash);
  if (!hashVerifies) {
    throw new Error(
      "Generated password hash failed verification — aborting without any database changes."
    );
  }

  // ---- Transactional update: email + password_hash together, exactly 1 row ----
  const client = await pool.getConnection();
  try {
    await client.beginTransaction();

    // NOTE: the db adapter returns [rows, undefined] (mysql2 shape) with
    // affectedRows attached to the FIRST element — same convention as the
    // model layer (const [result] = await pool.query(...)).
    const [updateResult] = await client.query(
      "UPDATE admins SET email = ?, password_hash = ? WHERE id = ?",
      [newEmail, passwordHash, target.id]
    );

    const affectedRows = updateResult?.affectedRows ?? 0;
    if (affectedRows !== 1) {
      throw new Error(
        `Expected exactly 1 updated row but ${affectedRows} were affected — transaction rolled back.`
      );
    }

    await client.commit();

    // ---- Post-commit verification: exactly one admin now owns the email ----
    const [verifyRows] = await pool.query(
      "SELECT id FROM admins WHERE email = ?",
      [newEmail]
    );
    const verified =
      verifyRows.length === 1 && verifyRows[0].id === target.id;

    console.log(
      verified
        ? "Admin credentials updated successfully."
        : "Admin credentials updated, but post-update verification could not confirm the record."
    );
    console.log(`Admin email: ${newEmail}`);
    console.log(`Updated records: ${affectedRows}`);
    if (!updateEmail) {
      console.log("(Email already matched ADMIN_EMAIL — only the password was changed.)");
    }
  } catch (error) {
    await client.rollback();
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error("Failed to update admin credentials:", error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
