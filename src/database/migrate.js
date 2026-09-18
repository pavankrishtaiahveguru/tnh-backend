import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import pool from "../config/database.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "..", "database.pg.sql");

// Applies the full PostgreSQL schema (database.pg.sql). Every statement is
// idempotent (CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE, DROP
// TRIGGER IF EXISTS + CREATE TRIGGER), so this is safe to re-run.
export async function migrate() {
  const schema = readFileSync(schemaPath, "utf8");
  await pool.query(schema);
}

if (process.argv[1]?.endsWith("/migrate.js")) {
  migrate()
    .then(() => console.log("Database migrations complete."))
    .catch((error) => {
      console.error("Database migration failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
