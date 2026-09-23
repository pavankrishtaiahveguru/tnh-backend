// ==================================================
// Read-only diagnostic for the Category → Subcategory → Service → Branch
// relationship flow. NO writes — safe against production data.
// Run: node scripts/diagnoseCatalogRelations.mjs [--json]
// ==================================================
import "dotenv/config";
import pool from "../src/config/database.js";

const q = (sql, params) => pool.query(sql, params).then((r) => r[0]);
const n = (v) => (v == null ? 0 : Number(v));

// ---- Counts ----
const [{ c: catCount }] = await q(`SELECT COUNT(*) AS c FROM categories`);
const [{ c: subCount }] = await q(`SELECT COUNT(*) AS c FROM sub_categories`);
const [{ c: svcCount }] = await q(`SELECT COUNT(*) AS c FROM services`);
const [{ c: brCount }] = await q(`SELECT COUNT(*) AS c FROM branches`);
const [{ c: linkCount }] = await q(`SELECT COUNT(*) AS c FROM service_branches`);

console.log("=== COUNTS ===");
console.log(`categories: ${catCount} | sub_categories: ${subCount} | services: ${svcCount} | branches: ${brCount} | service_branches links: ${linkCount}`);

// ---- Integrity: FK-target existence + parent-category mismatch ----
console.log("\n=== INTEGRITY: services → sub_categories parent mismatch ===");
const mismatchRows = await q(`
  SELECT s.id, s.slug, s.name AS service_name, s.category_id AS svc_cat,
         c.name AS svc_cat_name,
         s.sub_category_id, sc.name AS sub_name, sc.category_id AS sub_cat,
         c2.name AS sub_owner_name
  FROM services s
  INNER JOIN sub_categories sc ON sc.id = s.sub_category_id
  INNER JOIN categories c ON c.id = s.category_id
  INNER JOIN categories c2 ON c2.id = sc.category_id
  WHERE sc.category_id <> s.category_id
  ORDER BY s.id`);
console.log(`services whose subcategory belongs to a DIFFERENT category: ${mismatchRows.length}`);
for (const r of mismatchRows.slice(0, 20)) {
  console.log(`  - svc "${r.service_name}" (${r.slug}) cat=${r.svc_cat_name} → sub "${r.sub_name}" (belongs to ${r.sub_owner_name})`);
}

console.log("\n=== INTEGRITY: NULL / invalid mappings ===");
const [{ c: nullSub }] = await q(`SELECT COUNT(*) AS c FROM services WHERE sub_category_id IS NULL`);
console.log(`services with NULL sub_category_id: ${nullSub}`);
if (n(nullSub) > 0) {
  const nullRows = await q(`
    SELECT s.slug, s.name, c.name AS cat_name
    FROM services s INNER JOIN categories c ON c.id = s.category_id
    WHERE s.sub_category_id IS NULL ORDER BY c.name, s.name LIMIT 30`);
  for (const r of nullRows) console.log(`  - "${r.name}" (${r.slug}) in category "${r.cat_name}"`);
}

const invalidCat = await q(`
  SELECT s.id, s.slug FROM services s
  LEFT JOIN categories c ON c.id = s.category_id
  WHERE c.id IS NULL`);
console.log(`services pointing to nonexistent categories: ${invalidCat.length}`);

const invalidSub = await q(`
  SELECT s.id, s.slug FROM services s
  LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
  WHERE s.sub_category_id IS NOT NULL AND sc.id IS NULL`);
console.log(`services pointing to nonexistent subcategories: ${invalidSub.length}`);

// ---- Duplicates ----
console.log("\n=== DUPLICATES ===");
const dupSubs = await q(`
  SELECT sc.category_id, c.name AS cat_name, LOWER(sc.slug) AS slug, COUNT(*) AS cnt,
         STRING_AGG(sc.name || ' (id=' || sc.id || ')', ' | ') AS variants
  FROM sub_categories sc INNER JOIN categories c ON c.id = sc.category_id
  GROUP BY sc.category_id, c.name, LOWER(sc.slug)
  HAVING COUNT(*) > 1`);
console.log(`duplicate (category_id, slug) groups: ${dupSubs.length}`);
for (const d of dupSubs) console.log(`  - cat "${d.cat_name}": ${d.cnt}× "${d.slug}" → ${d.variants}`);

const dupCats = await q(`
  SELECT LOWER(name) AS nm, COUNT(*) AS cnt,
         STRING_AGG(name || ' (id=' || id || ')', ' | ') AS ids
  FROM categories GROUP BY LOWER(name) HAVING COUNT(*) > 1`);
console.log(`duplicate category names: ${dupCats.length}`);
for (const d of dupCats) console.log(`  - "${d.nm}" ×${d.cnt}: ${d.ids}`);

// ---- Source vs DB comparison ----
console.log("\n=== SOURCE (services.js) VS DB ===");
const { services: sourceServices } = await import("../data/catalog-services.mjs");
const { serviceCategories: sourceCategories } = await import("../data/catalog-categories.mjs");

const dbCats = await q(`SELECT id, slug, name FROM categories`);
const dbCatBySlug = new Map(dbCats.map((c) => [c.slug, c]));

let srcCatMissing = 0;
for (const cat of sourceCategories) {
  if (!dbCatBySlug.has(cat.id)) {
    srcCatMissing += 1;
    console.log(`  MISSING category in DB: ${cat.id} (${cat.name})`);
  }
}

// expected subcategory pairs from source
const expectedPairs = new Map(); // "catSlug::subName" -> [names]
for (const svc of sourceServices) {
  if (!svc.subCategory) continue;
  const key = `${svc.categoryId}::${svc.subCategory}`;
  if (!expectedPairs.has(key)) expectedPairs.set(key, svc.subCategory);
}
console.log(`expected category::subcategory pairs from source: ${expectedPairs.size}`);

const dbSubs = await q(`SELECT sc.id, sc.category_id, c.slug AS cat_slug, sc.slug AS sub_slug, sc.name FROM sub_categories sc INNER JOIN categories c ON c.id = sc.category_id`);
const dbPairBySubId = new Map();
const dbPairByKey = new Map(); // cat_slug::lower(sub name)
for (const s of dbSubs) {
  const key = `${s.cat_slug}::${s.name.toLowerCase()}`;
  dbPairBySubId.set(s.id, `${s.cat_slug}::${s.name}`);
  dbPairByKey.set(key, s);
}

let missingSubs = [];
for (const [key, name] of expectedPairs) {
  const [catSlug, subName] = key.split("::");
  if (!dbCatBySlug.has(catSlug)) continue; // already reported
  if (!dbPairByKey.has(`${catSlug}::${subName.toLowerCase()}`)) {
    missingSubs.push({ catSlug, subName });
    console.log(`  MISSING subcategory in DB: ${catSlug} :: "${subName}"`);
  }
}
console.log(`missing category::subcategory pairs: ${missingSubs.length}`);

// extra subs in DB not in source (report only — maybe admin-created)
const extraSubs = await q(`
  SELECT sc.id, c.slug AS cat_slug, sc.name
  FROM sub_categories sc INNER JOIN categories c ON c.id = sc.category_id
  WHERE NOT EXISTS (
    SELECT 1 FROM services s WHERE s.sub_category_id = sc.id
  )`);
console.log(`subcategories with no services (candidate empty/admin-created): ${extraSubs.length}`);
for (const e of extraSubs.slice(0, 20)) console.log(`  - ${e.cat_slug} :: "${e.name}" (id=${e.id})`);

// ---- Per-service source-vs-DB mapping mismatches ----
console.log("\n=== SERVICE MAPPING MISMATCHES (source vs DB) ===");
const dbSvcRows = await q(`
  SELECT s.id, s.slug, s.category_id, s.sub_category_id, c.slug AS cat_slug,
         sc.name AS sub_name, c2.slug AS sub_owner_slug
  FROM services s
  INNER JOIN categories c ON c.id = s.category_id
  LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
  LEFT JOIN categories c2 ON c2.id = sc.category_id`);
const dbSvcBySlug = new Map(dbSvcRows.map((r) => [r.slug, r]));

let mapMismatches = 0;
let nullSubFromSource = 0;
for (const svc of sourceServices) {
  const db = dbSvcBySlug.get(svc.id);
  if (!db) {
    console.log(`  MISSING service in DB: ${svc.id} ("${svc.name}")`);
    continue;
  }
  const wantCat = svc.categoryId;
  const wantSub = svc.subCategory ?? null;
  const catOk = db.cat_slug === wantCat;
  const subOk = wantSub
    ? db.sub_name != null && db.sub_name.toLowerCase() === wantSub.toLowerCase()
    : db.sub_name == null;
  if (!catOk) {
    mapMismatches += 1;
    console.log(`  CAT MISMATCH: ${svc.id}: source=${wantCat} db=${db.cat_slug}`);
  } else if (!subOk) {
    mapMismatches + 1;
    mapMismatches = mapMismatches + 1;
    nullSubFromSource += wantSub == null ? 1 : 0;
    console.log(`  SUB MISMATCH: ${svc.id} ("${svc.name}") cat="${wantCat}" source sub="${wantSub}" db sub=${db.sub_name ?? "NULL"}${db.sub_owner_slug && db.sub_owner_slug !== wantCat ? ` (sub belongs to ${db.sub_bucket ?? db.sub_owner_slug})` : ""}${db.sub_name && !wantSub ? " (db has sub but source says none)" : ""}`);
  }
}
console.log(`service mapping mismatches: ${mapMismatches}`);

// ---- Category service counts (what admin sees) ----
console.log("\n=== CATEGORY SERVICE COUNTS (DB truth) ===");
const catCounts = await q(`
  SELECT c.id, c.slug, c.name,
         COUNT(s.id) AS svc_total,
         COUNT(s.id) FILTER (WHERE s.sub_category_id IS NULL) AS svc_no_sub
  FROM categories c
  LEFT JOIN services s ON s.category_id = c.id
  GROUP BY c.id, c.slug, c.name
  ORDER BY c.display_order, c.name`);
for (const row of catCounts) {
  console.log(`  ${row.name}: ${row.svc_total} services (${row.svc_no_sub} without subcategory)`);
}

console.log("\n=== SUMMARY ===");
console.log(`categories=${catCount} subs=${subCount} services=${svcCount}`);
console.log(`missing source categories in DB: ${srcCatMissing}`);
console.log(`missing source subcategory pairs: ${missingSubs.length}`);
console.log(`service mapping mismatches: ${mapMismatches}`);
console.log(`services with NULL subcategory: ${nullSub}`);
console.log(`subcat parent-category mismatches: ${mismatchRows.length}`);

await pool.end();
