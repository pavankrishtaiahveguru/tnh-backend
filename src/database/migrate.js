import dotenv from "dotenv";
import pool from "../config/database.js";

dotenv.config();

const migrations = [
  [
    "categories",
    "display_order",
    "ALTER TABLE categories ADD COLUMN display_order INT NOT NULL DEFAULT 0",
  ],
  [
    "services",
    "pricing_type_from",
    "ALTER TABLE services MODIFY COLUMN pricing_type ENUM('fixed', 'size', 'variant', 'from') NOT NULL DEFAULT 'fixed'",
  ],
  [
    "categories",
    "image",
    "ALTER TABLE categories ADD COLUMN image VARCHAR(500) NULL",
  ],
  [
    "services",
    "image",
    "ALTER TABLE services ADD COLUMN image VARCHAR(500) NULL",
  ],
  [
    "branches",
    "map_embed_url",
    "ALTER TABLE branches ADD COLUMN map_embed_url TEXT NULL",
  ],
  [
    "branches",
    "title",
    "ALTER TABLE branches ADD COLUMN title VARCHAR(255) NULL",
  ],
  [
    "branches",
    "subtitle",
    "ALTER TABLE branches ADD COLUMN subtitle VARCHAR(255) NULL",
  ],
  ["branches", "hours", "ALTER TABLE branches ADD COLUMN hours JSON NULL"],
  [
    "branches",
    "about_title",
    "ALTER TABLE branches ADD COLUMN about_title VARCHAR(255) NULL",
  ],
  [
    "services",
    "display_order",
    "ALTER TABLE services ADD COLUMN display_order INT NOT NULL DEFAULT 0",
  ],
];

export async function migrate() {
  for (const [table, column, statement] of migrations) {
    try {
      await pool.query(statement);
      console.log(`Added ${table}.${column}`);
    } catch (error) {
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    }
  }
  await pool.query(
    "UPDATE categories SET display_order = id WHERE display_order = 0",
  );
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
