// Cleanup of CONFIRMED test/debug catalog artifacts (IDs verified in the DB
// during the catalog-mapping diagnostics — never matched by name patterns):
//
//   SERVICES
//     id 290 → "test"         (Nails, sub_category_id NULL)
//     id 299 → "test service" (Bleach & D-Tan, sub_category_id NULL)
//   SUBCATEGORY
//     id 272 → "Test" (Bleach & D-Tan, slug "test", 0 services)
//
// Usage:
//   node scripts/cleanupTestCatalogData.mjs           → DRY RUN (default)
//   node scripts/cleanupTestCatalogData.mjs --apply   → actual cleanup
//
// Safety model:
//   - Every target is verified by ID **and** expected name/category BEFORE any
//     deletion. A mismatch aborts with nothing deleted.
//   - --apply runs inside ONE transaction; any failure rolls everything back.
//   - Subcategory 272 is only removed when zero services reference it.
//   - Dependent rows (service_branches) are deleted explicitly first — the
//     schema's ON DELETE CASCADE would handle them, but explicit removal keeps
//     the operation observable and satisfies the cleanup audit.
//   - Legitimate catalog data is never touched.
import dotenv from "dotenv";
dotenv.config();

import pool from "../src/config/database.js";

// The confirmed artifacts — id + the exact identity we expect to find.
const TARGET_SERVICES = [
  { id: 290, name: "test", categorySlug: "nails" },
  { id: 299, name: "test service", categorySlug: "bleach-d-tan" },
];
const TARGET_SUBCATEGORY = {
  id: 272,
  name: "Test",
  slug: "test",
  categorySlug: "bleach-d-tan",
};

const APPLY = process.argv.includes("--apply");

let exitCode = 0;
try {
  // ------------------------------------------------------------------
  // Verify every target BEFORE touching anything.
  // ------------------------------------------------------------------
  console.log("=== Verifying target records against expected identity ===");

  const services = [];
  for (const target of TARGET_SERVICES) {
    const [rows] = await pool.query(
      `SELECT s.id, s.slug, s.name, s.category_id, s.sub_category_id, s.is_active,
              c.slug AS category_slug, c.name AS category_name,
              (SELECT COUNT(*) FROM service_branches sb WHERE sb.service_id = s.id) AS branch_count,
              (SELECT COUNT(*) FROM service_variants v WHERE v.service_id = s.id) AS variant_count
       FROM services s
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.id = ?`,
      [target.id],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(
        `Service ${target.id} not found — expected "${target.name}". Nothing deleted.`,
      );
    }
    if (row.name !== target.name || row.category_slug !== target.categorySlug) {
      throw new Error(
        `Service ${target.id} identity mismatch: expected name "${target.name}" in category "${target.categorySlug}", found name "${row.name}" in "${row.category_slug}". Nothing deleted.`,
      );
    }
    services.push(row);
    console.log(
      `  service ${row.id} — "${row.name}" (${row.category_name}, sub=${
        row.sub_category_id ?? "NULL"
      }, active=${row.is_active}, branches=${row.branch_count}, variants=${row.variant_count}) ✓`,
    );
  }

  const [subRows] = await pool.query(
    `SELECT sc.id, sc.slug, sc.name, sc.category_id,
            c.name AS category_name, c.slug AS category_slug,
            (SELECT COUNT(*) FROM services s WHERE s.sub_category_id = sc.id) AS service_count
     FROM sub_categories sc
     JOIN categories c ON c.id = sc.category_id
     WHERE sc.id = ?`,
    [TARGET_SUBCATEGORY.id],
  );
  const sub = subRows[0];
  if (!sub) {
    throw new Error(
      `Subcategory ${TARGET_SUBCATEGORY.id} not found — nothing deleted.`,
    );
  }
  if (
    sub.name !== TARGET_SUBCATEGORY.name ||
    sub.slug !== TARGET_SUBCATEGORY.slug ||
    sub.category_slug !== TARGET_SUBCATEGORY.categorySlug
  ) {
    throw new Error(
      `Subcategory ${TARGET_SUBCATEGORY.id} identity mismatch: expected "${TARGET_SUBCATEGORY.name}" (slug "${TARGET_SUBCATEGORY.slug}") under "${TARGET_SUBCATEGORY.categorySlug}", found "${sub.name}" (slug "${sub.slug}") under "${sub.category_slug}". Nothing deleted.`,
    );
  }
  if (Number(sub.service_count) !== 0) {
    throw new Error(
      `Subcategory ${sub.id} still has ${sub.service_count} service(s) — refusing to delete. Nothing deleted.`,
    );
  }
  console.log(
    `  subcategory ${sub.id} — "${sub.name}" (${sub.category_name}, slug "${sub.slug}", services=${sub.service_count}) ✓`,
  );

  // ------------------------------------------------------------------
  // Report / delete
  // ------------------------------------------------------------------
  if (!APPLY) {
    console.log("\nDRY RUN — no data changed. TEST SERVICES FOUND:");
    for (const s of services) {
      console.log(`  id ${s.id} - ${s.name}`);
    }
    console.log("TEST SUBCATEGORY:");
    console.log(
      `  id ${sub.id} - ${sub.name}\n  category = ${sub.category_name}\n  services = ${sub.service_count}`,
    );
    console.log("\nRe-run with --apply to perform the cleanup.");
  } else {
    console.log("\n=== Applying cleanup (single transaction) ===");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Re-verify inside the transaction (guards against a concurrent change
      // between the pre-checks above and the deletions below).
      for (const target of TARGET_SERVICES) {
        const [rows] = await connection.query(
          `SELECT id, name FROM services WHERE id = ? FOR UPDATE`,
          [target.id],
        );
        if (!rows[0] || rows[0].name !== target.name) {
          throw new Error(
            `In-transaction verification failed for service ${target.id}.`,
          );
        }
      }
      const [subTxRows] = await connection.query(
        `SELECT id, name, (SELECT COUNT(*) FROM services WHERE sub_category_id = sc.id) AS service_count
         FROM sub_categories sc WHERE id = ? FOR UPDATE`,
        [TARGET_SUBCATEGORY.id],
      );
      if (!subTxRows[0] || subTxRows[0].name !== TARGET_SUBCATEGORY.name) {
        throw new Error(
          `In-transaction verification failed for subcategory ${TARGET_SUBCATEGORY.id}.`,
        );
      }
      if (Number(subTxRows[0].service_count) !== 0) {
        throw new Error(
          `In-transaction check: subcategory ${TARGET_SUBCATEGORY.id} gained services — aborting.`,
        );
      }

      // 1. Dependent rows first (explicit; schema CASCADE would also cover it).
      for (const target of TARGET_SERVICES) {
        const [brResult] = await connection.query(
          `DELETE FROM service_branches WHERE service_id = ?`,
          [target.id],
        );
        console.log(
          `  deleted ${brResult.affectedRows} service_branches row(s) for service ${target.id}`,
        );
        // Variants (none exist for these IDs, but keep the flow complete).
        await connection.query(`DELETE FROM service_variants WHERE service_id = ?`, [
          target.id,
        ]);
      }

      // 2. The services.
      for (const target of TARGET_SERVICES) {
        const [result] = await connection.query(
          `DELETE FROM services WHERE id = ?`,
          [target.id],
        );
        if (result.affectedRows !== 1) {
          throw new Error(`Service ${target.id} delete affected ${result.affectedRows} row(s).`);
        }
        console.log(`  deleted service ${target.id} ("${target.name}")`);
      }

      // 3. The subcategory (0 services — safe).
      const [subResult] = await connection.query(
        `DELETE FROM sub_categories WHERE id = ?`,
        [TARGET_SUBCATEGORY.id],
      );
      if (subResult.affectedRows !== 1) {
        throw new Error(
          `Subcategory ${TARGET_SUBCATEGORY.id} delete affected ${subResult.affectedRows} row(s).`,
        );
      }
      console.log(`  deleted subcategory ${TARGET_SUBCATEGORY.id} ("${TARGET_SUBCATEGORY.name}")`);

      await connection.commit();
      console.log("  committed ✓");
    } catch (error) {
      await connection.rollback();
      console.error("  ROLLED BACK — no data changed:", error.message);
      throw error;
    } finally {
      connection.release();
    }

    // ------------------------------------------------------------------
    // Post-cleanup validation
    // ------------------------------------------------------------------
    console.log("\n=== Post-cleanup validation ===");
    const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM services`);
    const [subCountRows] = await pool.query(`SELECT COUNT(*) AS c FROM sub_categories`);
    console.log(`  services remaining: ${countRows[0].c}`);
    console.log(`  subcategories remaining: ${subCountRows[0].c}`);

    const [goneServices] = await pool.query(
      `SELECT id FROM services WHERE id IN (?, ?)`,
      [TARGET_SERVICES[0].id, TARGET_SERVICES[1].id],
    );
    if (goneServices.length === 0) {
      console.log(
        `  services ${TARGET_SERVICES.map((s) => s.id).join(" and ")}: gone ✓`,
      );
    } else {
      console.error(
        `  UNEXPECTED: still present: ${goneServices.map((r) => r.id).join(", ")}`,
      );
      exitCode = 1;
    }

    const [goneSub] = await pool.query(
      `SELECT id FROM sub_categories WHERE id = ?`,
      [TARGET_SUBCATEGORY.id],
    );
    if (goneSub.length === 0) {
      console.log(`  subcategory ${TARGET_SUBCATEGORY.id}: gone ✓`);
    } else {
      console.error(`  UNEXPECTED: subcategory ${TARGET_SUBCATEGORY.id} still present`);
      exitCode = 1;
    }

    const [orphans] = await pool.query(
      `SELECT COUNT(*) AS c FROM service_branches sb
       WHERE NOT EXISTS (SELECT 1 FROM services s WHERE s.id = sb.service_id)`,
    );
    if (Number(orphans[0].c) === 0) {
      console.log("  orphan service_branches rows: 0 ✓");
    } else {
      console.error(`  UNEXPECTED: ${orphans[0].c} orphan service_branches row(s)`);
      exitCode = 1;
    }
  }
} catch (error) {
  console.error("CLEANUP FAILED:", error.message);
  exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  process.exit(exitCode);
}
