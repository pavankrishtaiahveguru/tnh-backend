import dotenv from "dotenv";
import pool, { testConnection } from "./src/config/database.js";
dotenv.config();

await testConnection();

console.log("=== 1. sub_categories table contents ===");
const [subs] = await pool.query(`SELECT id, category_id, slug, name FROM sub_categories ORDER BY category_id, name`);
console.log(`total sub_categories rows: ${subs.length}`);
for (const s of subs) console.log(`  cat=${s.category_id} id=${s.id} slug=${s.slug} name=${s.name}`);

console.log("\n=== 2. categories ===");
const [cats] = await pool.query(`SELECT id, slug, name FROM categories ORDER BY id`);
for (const c of cats) console.log(`  id=${c.id} slug=${c.slug} name=${c.name}`);

console.log("\n=== 3. services relationship health ===");
const [[svcTotal]] = await pool.query(`SELECT COUNT(*) AS count FROM services`);
const [[svcWithSub]] = await pool.query(`SELECT COUNT(*) AS count FROM services WHERE sub_category_id IS NOT NULL`);
const [[svcNullSub]] = await pool.query(`SELECT COUNT(*) AS count FROM services WHERE sub_category_id IS NULL`);
console.log(`services total=${svcTotal.count}, with sub=${svcWithSub.count}, NULL sub=${svcNullSub.count}`);

console.log("\n=== 4. per-category service/sub linkage ===");
const [perCat] = await pool.query(`
  SELECT c.id, c.slug,
    (SELECT COUNT(*) FROM services s WHERE s.category_id = c.id) AS services,
    (SELECT COUNT(*) FROM sub_categories sc WHERE sc.category_id = c.id) AS subs,
    (SELECT COUNT(*) FROM services s WHERE s.sub_category_id IN (SELECT id FROM sub_categories WHERE category_id = c.id)) AS linked
  FROM categories c ORDER BY c.id`);
for (const r of perCat) console.log(`  ${r.slug}: services=${r.services} subs=${r.subs} linked=${r.linked}`);

console.log("\n=== 5. Nail subcategory service counts (the expected chips) ===");
const [nail] = await pool.query(`SELECT id FROM categories WHERE slug = 'nails'`);
if (nail.length > 0) {
  const nailId = nail[0].id;
  const [counts] = await pool.query(`
    SELECT sc.id, sc.name, COUNT(s.id) AS service_count
    FROM sub_categories sc
    LEFT JOIN services s ON s.sub_category_id = sc.id
    WHERE sc.category_id = ${nailId}
    GROUP BY sc.id, sc.name
    ORDER BY sc.name`);
  for (const r of counts) console.log(`  ${r.name}: ${r.service_count}`);
} else {
  console.log("  nails category not found!");
}

await pool.end();
