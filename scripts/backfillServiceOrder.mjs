// ==================================================
// Backfill: services.display_order for the existing catalog
// ==================================================
// The catalog seeder assigns a GLOBAL running display_order (0..n across the
// whole services table), so each category+subcategory scope holds sparse,
// non-contiguous values (e.g. 5, 18, 42). Their RELATIVE order within the
// scope is exactly what the public Services page has always shown — this
// one-off, IDEMPOTENT script only DENSIFIES each scope to 0..n-1 while
// preserving that relative order, so the switch to per-scope contiguous
// display_order is invisible to admins and customers on first deploy.
//
// Scope isolation: services of one category+subcategory never influence the
// numbering of another scope. Services with sub_category_id IS NULL form
// their own scope under (category_id, NULL).
//
// Only touches scopes that are NOT already dense (0..n-1 in canonical
// display_order ASC, id ASC order). Every scope written by the reorder
// endpoint, service create (append MAX+1), delete (gap normalization) and
// category/subcategory re-assignment is always dense — so a dense scope is
// either already backfilled or carries an admin's saved custom order, and
// this script will never overwrite it. Re-running after admins have started
// reordering is therefore always safe: dense scopes are skipped entirely.
//
// Run with: npm run backfill:service-order
// Only services.display_order is written — no ids, slugs, names,
// category_id, sub_category_id, prices, variants, branches, audience or
// status fields are touched.
// ==================================================
import dotenv from "dotenv";
import pool, { testConnection } from "../src/config/database.js";

dotenv.config();

async function backfill() {
  await testConnection();

  const [rows] = await pool.query(
    `SELECT id, category_id, sub_category_id, name, display_order
     FROM services
     ORDER BY category_id ASC, sub_category_id ASC NULLS FIRST,
              display_order ASC, id ASC`,
  );

  const byScope = new Map();
  for (const row of rows) {
    const key = `${row.category_id}:${row.sub_category_id ?? "null"}`;
    const list = byScope.get(key) ?? [];
    list.push(row);
    byScope.set(key, list);
  }

  let scopesUpdated = 0;
  let scopesSkipped = 0;
  let rowsUpdated = 0;

  for (const [scopeKey, services] of byScope) {
    // Already dense (0..n-1)? The scope is either backfilled or carries an
    // admin's saved order — never touch it.
    const isDense = services.every(
      (service, position) => Number(service.display_order) === position,
    );
    if (isDense) {
      scopesSkipped += 1;
      continue;
    }

    for (let position = 0; position < services.length; position += 1) {
      // Preserve relative order: canonical row at position gets order value
      // `position`. Skip no-op writes.
      if (Number(services[position].display_order) === position) continue;
      await pool.query(`UPDATE services SET display_order = ? WHERE id = ?`, [
        position,
        services[position].id,
      ]);
      rowsUpdated += 1;
    }
    scopesUpdated += 1;
    console.log(
      `  category ${services[0].category_id}, sub ${services[0].sub_category_id ?? "—"}: ${services.length} service(s) densified`,
    );
    void scopeKey;
  }

  console.log(
    `\nDone. ${scopesUpdated} scope${scopesUpdated === 1 ? "" : "s"} densified, ` +
      `${scopesSkipped} already dense (skipped), ${rowsUpdated} row(s) updated.`,
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
