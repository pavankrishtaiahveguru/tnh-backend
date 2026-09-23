// ==================================================
// Backfill: sub_categories.display_order for the existing catalog
// ==================================================
// Adding the display_order column (default 0) leaves every existing
// sub-category tied at 0, so `ORDER BY display_order, id` would silently
// fall back to insertion-id order — NOT the alphabetical-by-name order the
// admin UI and the old `ORDER BY sc.name` queries have always shown. This
// one-off, IDEMPOTENT script initializes display_order from that same
// current order (name ASC, per category) so the switch to display_order is
// invisible to admins and customers on first deploy.
//
// Only touches categories where EVERY sub-category is still at the column
// default (display_order = 0). A category with any non-zero value has
// already been reordered by an admin (or already backfilled) — its order is
// live production data and this script will never overwrite it. Re-running
// this script after admins have started reordering is therefore always
// safe: already-touched categories are skipped entirely.
//
// Run with: npm run backfill:subcategory-order
// Only sub_categories.display_order is written — no ids, slugs, names,
// category_id, or service mappings are touched.
// ==================================================
import dotenv from "dotenv";
import pool, { testConnection } from "../src/config/database.js";

dotenv.config();

async function backfill() {
  await testConnection();

  const [rows] = await pool.query(
    `SELECT id, category_id, name, display_order
     FROM sub_categories
     ORDER BY category_id, name ASC, id ASC`,
  );

  const byCategory = new Map();
  for (const row of rows) {
    const list = byCategory.get(row.category_id) ?? [];
    list.push(row);
    byCategory.set(row.category_id, list);
  }

  let categoriesUpdated = 0;
  let categoriesSkipped = 0;
  let rowsUpdated = 0;

  for (const [categoryId, subs] of byCategory) {
    const untouched = subs.every((sub) => Number(sub.display_order) === 0);
    if (!untouched) {
      categoriesSkipped += 1;
      continue;
    }

    for (let position = 0; position < subs.length; position += 1) {
      // First (alphabetically) sub-category already sits at the column
      // default of 0 — skip the no-op write, update the rest.
      if (position === 0) continue;
      await pool.query(`UPDATE sub_categories SET display_order = ? WHERE id = ?`, [
        position,
        subs[position].id,
      ]);
      rowsUpdated += 1;
    }
    categoriesUpdated += 1;
    console.log(
      `  category ${categoryId}: ${subs.map((s) => s.name).join(" -> ")}`,
    );
  }

  console.log(
    `\nDone. ${categoriesUpdated} categor${categoriesUpdated === 1 ? "y" : "ies"} initialized, ` +
      `${categoriesSkipped} already ordered (skipped), ${rowsUpdated} row(s) updated.`,
  );
}

backfill()
  .then(() => pool.end())
  .catch((error) => {
    console.error("Backfill failed:", error.message);
    pool.end().finally(() => {
      process.exitCode = 1;
    });
  });
