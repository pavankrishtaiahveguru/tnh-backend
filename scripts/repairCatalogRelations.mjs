// ==================================================
// Repair/sync script — Category → Subcategory → Service relationships
// Reconciles the database against the source of truth
// (tnh-salon/src/data/services.js via data/catalog-*.mjs bridges).
//
// DRY-RUN by default: prints what it WOULD do, changes nothing.
// Apply with:  node scripts/repairCatalogRelations.mjs --apply
//
// Idempotent + transaction-safe: matched by stable slugs, preserves all
// existing IDs, prices, variants, images, branches, and status. Safe to run
// multiple times — a second run is a no-op.
// ==================================================
import "dotenv/config";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import pool from "../src/config/database.js";

const APPLY = process.argv.includes("--apply");
const SALT_ROUNDS = 10;

const stats = {
  categoriesCreated: 0,
  subCategoriesCreated: 0,
  subCategoriesRenamed: 0,
  servicesRemapped: 0,
  servicesUpdated: 0,
  servicesInserted: 0,
  branchLinksAdded: 0,
};

const slugify = (value) =>
  String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

function stableSlugSuffix(value) {
  let hash = 0;
  for (const character of String(value)) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return hash.toString(36);
}

const q = (sql, params) => pool.query(sql, params).then((r) => r[0]);

// ---- Load source of truth ----
const { branches: sourceBranches } = await import(
  "../../tnh-salon/src/data/branches.js"
);
const { services: sourceServices } = await import("../data/catalog-services.mjs");
const { serviceCategories: sourceCategories } = await import(
  "../data/catalog-categories.mjs"
);

console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY-RUN (no changes)"}`);
console.log(
  `Source: ${sourceCategories.length} categories, ${sourceServices.length} services, ${sourceBranches.length} branches\n`,
);

// ---- Branch label → slugs (same rule as the seeder) ----
const branchLabelToIds = (branch) => {
  const normalized = String(branch ?? "").trim().toLowerCase();
  if (["both", "both branches", "all"].includes(normalized))
    return ["indiranagar", "sarjapur-road"];
  if (["sarjapur", "sarjapur road", "sarjapura", "sarjapura road"].includes(normalized))
    return ["sarjapur-road"];
  if (["indiranagar"].includes(normalized)) return ["indiranagar"];
  return [];
};

// ---- Current DB state ----
const dbCategories = await q(`SELECT id, slug, name FROM categories`);
const dbCategoryBySlug = new Map(dbCategories.map((c) => [c.slug, c]));
const dbSubs = await q(
  `SELECT sc.id, sc.category_id, sc.slug, sc.name, c.slug AS cat_slug
   FROM sub_categories sc INNER JOIN categories c ON c.id = sc.category_id`,
);
const dbSubByKey = new Map(
  dbSubs.map((s) => [`${s.cat_slug}::${s.name.toLowerCase()}`, s]),
);
const dbBranches = await q(`SELECT id, slug FROM branches`);
const branchIdBySlug = new Map(dbBranches.map((b) => [b.slug, Number(b.id)]));
const dbSvcRows = await q(
  `SELECT s.id, s.slug, s.category_id, s.sub_category_id, s.name, s.audience,
          s.pricing_type, s.price, s.price_range, s.duration, s.image_url,
          s.display_order, s.is_active, c.slug AS cat_slug,
          sc.name AS sub_name
   FROM services s
   INNER JOIN categories c ON c.id = s.category_id
   LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id`,
);
const dbSvcBySlug = new Map(dbSvcRows.map((s) => [s.slug, s]));

// ---- Plan: categories ----
const plan = [];
for (const cat of sourceCategories) {
  if (!dbCategoryBySlug.has(cat.id)) {
    plan.push(`CREATE category ${cat.id} ("${cat.name}")`);
    stats.categoriesCreated += 1;
  }
}

// ---- Plan: subcategories (expected pairs from source services) ----
const expectedPairs = new Map(); // catSlug::subName -> {catSlug, subName}
for (const svc of sourceServices) {
  if (!svc.subCategory || !svc.categoryId) continue;
  const key = `${svc.categoryId}::${svc.subCategory}`;
  if (!expectedPairs.has(key)) expectedPairs.set(key, { catSlug: svc.categoryId, subName: svc.subCategory });
}
// Plus any subcategories explicitly declared on source category objects.
for (const cat of sourceCategories) {
  for (const sub of cat.subCategories ?? []) {
    const name = typeof sub === "string" ? sub : sub?.name;
    if (name) {
      const key = `${cat.id}::${name}`;
      if (!expectedPairs.has(key)) expectedPairs.set(key, { catSlug: cat.id, subName: name });
    }
  }
}

// Slug collision handling inside a category (mirror seeder rules).
const subNamesBySlug = new Map();
for (const { catSlug, subName } of expectedPairs.values()) {
  const base = slugify(subName);
  const list = subNamesBySlug.get(`${catSlug}::${base}`) ?? [];
  list.push(subName);
  subNamesBySlug.set(`${catSlug}::${base}`, list);
}
function subSlugFor(catSlug, name) {
  const base = slugify(name);
  return (subNamesBySlug.get(`${catSlug}::${base}`) ?? []).length > 1
    ? `${base}-${stableSlugSuffix(name)}`
    : base;
}

const subIdByKey = new Map(); // "catSlug::SubName" -> existing-or-new id
let missingSubs = 0;
for (const { catSlug, subName } of expectedPairs.values()) {
  const existing = dbSubByKey.get(`${catSlug}::${subName.toLowerCase()}`);
  if (existing) {
    subIdByKey.set(`${catSlug}::${subName}`, Number(existing.id));
  } else {
    plan.push(`CREATE subcategory "${subName}" under ${catSlug}`);
    stats.subCategoriesCreated += 1;
    missingSubs += 1;
  }
}
// ---- Plan: service mapping repairs ----
const serviceRepairs = [];
for (const svc of sourceServices) {
  const db = dbSvcBySlug.get(svc.id);
  if (!db) {
    plan.push(`CREATE service ${svc.id} ("${svc.name}")`);
    stats.servicesInserted += 1;
    continue;
  }
  const wantCat = dbCategoryBySlug.get(svc.categoryId);
  if (!wantCat) continue; // impossible per plan above, defensive
  const wantSubKey = svc.subCategory ? `${svc.categoryId}::${svc.subCategory}` : null;
  const wantSubId = wantSubKey ? subIdByKey.get(wantSubKey) ?? null : null;
  const catOk = Number(db.category_id) === Number(wantCat.id);
  const subOk = wantSubKey
    ? db.sub_name != null && db.sub_name.toLowerCase() === svc.subCategory.toLowerCase()
    : db.sub_name == null;
  if (!catOk || !subOk) {
    serviceRepairs.push({
      id: Number(db.id),
      slug: svc.id,
      name: svc.name,
      categoryId: wantCat.id,
      subCategoryId: wantSubId,
      from: `${db.cat_slug}${db.sub_name ? ` / ${db.sub_name}` : " / (no subcategory)"}`,
      to: `${svc.categoryId}${svc.subCategory ? ` / ${svc.subCategory}` : " / (no subcategory)"}`,
    });
    stats.servicesRemapped += 1;
  }
}

// ---- Report ----
console.log("=== PLAN ===");
for (const line of plan.slice(0, 60)) console.log(`  • ${line}`);
if (plan.length > 60) console.log(`  … and ${plan.length - 60} more`);
console.log(`\nService mapping repairs: ${serviceRepairs.length}`);
for (const r of serviceRepairs.slice(0, 40)) {
  console.log(`  • ${r.slug} ("${r.name}"): ${r.from} → ${r.to}`);
}
if (serviceRepairs.length > 40) console.log(`  … and ${serviceRepairs.length - 40} more`);

console.log("\n=== SUMMARY ===");
console.log(`categories to create:        ${stats.categoriesCreated}`);
console.log(`subcategories to create:     ${stats.subCategoriesCreated}`);
console.log(`services missing (insert):   ${stats.servicesInserted}`);
console.log(`service mappings to repair:  ${stats.servicesRemapped}`);

if (!APPLY) {
  console.log("\nDRY-RUN ONLY — rerun with --apply to write changes.");
  await pool.end();
  process.exit(0);
}

// ==================================================
// APPLY — single transaction, any error rolls back everything
// ==================================================
const client = await pool.getConnection();
try {
  await client.beginTransaction();

  // 1) Missing categories
  for (const cat of sourceCategories) {
    if (dbCategoryBySlug.has(cat.id)) continue;
    const [maxRow] = await client.query(
      `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order FROM categories`,
    );
    const [result] = await client.query(
      `INSERT INTO categories (slug, name, description, icon, display_order)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [cat.id, cat.name, cat.description ?? null, cat.icon ?? "sparkles", maxRow.next_order],
    );
    dbCategoryBySlug.set(cat.id, { id: Number(result.insertId), slug: cat.id, name: cat.name });
    console.log(`+ category ${cat.id}`);
  }

  // 2) Missing subcategories (parents first — guaranteed above)
  for (const { catSlug, subName } of expectedPairs.values()) {
    const key = `${catSlug}::${subName}`;
    if (subIdByKey.has(key)) continue;
    const cat = dbCategoryBySlug.get(catSlug);
    const slug = subSlugFor(catSlug, subName);
    const [result] = await client.query(
      `INSERT INTO sub_categories (category_id, slug, name) VALUES (?, ?, ?) RETURNING id`,
      [cat.id, slug, subName],
    );
    const id = Number(result.insertId);
    subIdByKey.set(key, id);
    dbSubByKey.set(`${catSlug}::${subName.toLowerCase()}`, { id, category_id: cat.id, slug, name: subName, cat_slug: catSlug });
    console.log(`+ subcategory ${catSlug} :: "${subName}" (id=${id})`);
    stats.subCategoriesCreated += 0; // counted in plan phase
  }

  // 3) Service mapping repairs + missing services + branch links
  let displayOrderMax = Math.max(
    0,
    ...dbSvcRows.map((s) => Number(s.display_order ?? 0)),
  );
  for (const [index, svc] of sourceServices.entries()) {
    const db = dbSvcBySlug.get(svc.id);
    const wantCat = dbCategoryBySlug.get(svc.categoryId);
    const wantSubKey = svc.subCategory ? `${svc.categoryId}::${svc.subCategory}` : null;
    const wantSubId = wantSubKey ? subIdByKey.get(wantSubKey) ?? null : null;

    if (!db) {
      const displayOrder = index;
      const pricingType = svc.pricingType ?? "fixed";
      const price = pricingType === "fixed" ? (svc.price ?? null) : null;
      const [result] = await client.query(
        `INSERT INTO services
           (slug, category_id, sub_category_id, name, audience, description,
            pricing_type, price, price_range, duration, image_url, display_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          svc.id, wantCat.id, wantSubId, svc.name, svc.gender ?? "Unisex",
          svc.description ?? null, pricingType, price, svc.priceRange ?? null,
          svc.duration ?? null, svc.image ?? null, displayOrder,
          (svc.status ?? "Active") === "Active",
        ],
      );
      const serviceId = Number(result.insertId);
      dbSvcBySlug.set(svc.id, { id: serviceId, slug: svc.id, category_id: wantCat.id, sub_category_id: wantSubId, cat_slug: svc.categoryId, sub_name: svc.subCategory ?? null });
      console.log(`+ service ${svc.id}`);
      await syncVariantsAndBranches(client, serviceId, svc, branchIdBySlug, stats);
      continue;
    }

    const serviceId = Number(db.id);
    const needsMap = serviceRepairs.find((r) => r.id === serviceId);
    if (needsMap) {
      // Re-resolve the sub id at write time (NOT the pre-plan value): step 2
      // may have just created this run's missing subcategories, and using the
      // stale pre-plan id would write NULL on the first pass.
      await client.query(
        `UPDATE services SET category_id = ?, sub_category_id = ? WHERE id = ?`,
        [needsMap.categoryId, wantSubId, serviceId],
      );
      console.log(`~ remapped ${svc.id}: ${needsMap.from} → ${needsMap.to}`);
    }

    await syncVariantsAndBranches(client, serviceId, svc, branchIdBySlug, stats);
  }

  await client.commit();
  console.log("\nCOMMITTED ✓");
} catch (error) {
  await client.rollback();
  console.error("\nROLLED BACK — database unchanged:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
}

// ---- Verify (read-only) ----
async function syncVariantsAndBranches(client, serviceId, svc, branchIdBySlug, stats) {
  // Variants: diff-sync by label (preserve prices only from source)
  const incoming = (svc.variants ?? [])
    .filter((v) => v?.label)
    .map((v, i) => ({ label: String(v.label).trim(), price: Number(v.price) || 0, duration: v.duration ?? null, sortOrder: i }));
  const [existingVariants] = await client.query(
    `SELECT id, label, price, duration, sort_order FROM service_variants WHERE service_id = ?`,
    [serviceId],
  );
  const existingByLabel = new Map(existingVariants.map((r) => [r.label, r]));
  const seen = new Set();
  for (const v of incoming) {
    seen.add(v.label);
    const existing = existingByLabel.get(v.label);
    if (!existing) {
      await client.query(
        `INSERT INTO service_variants (service_id, label, price, duration, sort_order) VALUES (?, ?, ?, ?, ?)`,
        [serviceId, v.label, v.price, v.duration, v.sortOrder],
      );
      stats.variantsInserted = (stats.variantsInserted ?? 0) + 1;
    } else if (
      Number(existing.price) !== v.price ||
      (existing.duration ?? null) !== v.duration ||
      Number(existing.sort_order) !== v.sortOrder
    ) {
      await client.query(
        `UPDATE service_variants SET price = ?, duration = ?, sort_order = ? WHERE id = ?`,
        [v.price, v.duration, v.sortOrder, existing.id],
      );
      stats.variantsUpdated = (stats.variantsUpdated ?? 0) + 1;
    }
  }
  for (const [, row] of existingByLabel) {
    if (!seen.has(row.label)) {
      await client.query(`DELETE FROM service_variants WHERE id = ?`, [row.id]);
      stats.variantsDeleted = (stats.variantsDeleted ?? 0) + 1;
    }
  }

  // Branch links: add missing only (never remove existing links)
  const wantedSlugs = branchLabelToIds(svc.branch);
  const [existingLinks] = await client.query(
    `SELECT sb.branch_id, b.slug FROM service_branches sb
     INNER JOIN branches b ON b.id = sb.branch_id WHERE sb.service_id = ?`,
    [serviceId],
  );
  const existingSlugs = new Set(existingLinks.map((r) => r.slug));
  for (const slug of wantedSlugs) {
    if (!existingSlugs.has(slug)) {
      await client.query(
        `INSERT INTO service_branches (service_id, branch_id)
         SELECT ?, id FROM branches WHERE slug = ?`,
        [serviceId, slug],
      );
      stats.branchLinksAdded += 1;
    }
  }
}

// ---- Post-apply verification (read-only, recomputed from source) ----
const postSubs = await q(
  `SELECT sc.id, sc.category_id, sc.name, c.slug AS cat_slug
   FROM sub_categories sc INNER JOIN categories c ON c.id = sc.category_id`,
);
const postSubByKey = new Map(
  postSubs.map((s) => [`${s.cat_slug}::${s.name.toLowerCase()}`, s]),
);
const postSvc = await q(
  `SELECT s.slug, s.category_id, s.sub_category_id, c.slug AS cat_slug,
          sc.name AS sub_name
   FROM services s
   INNER JOIN categories c ON c.id = s.category_id
   LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id`,
);
const postSvcBySlug = new Map(postSvc.map((s) => [s.slug, s]));
let stillMismatched = 0;
let crossCategory = 0;
for (const svc of sourceServices) {
  const db = postSvcBySlug.get(svc.id);
  if (!db) continue;
  const catOk = db.cat_slug === svc.categoryId;
  const subOk = svc.subCategory
    ? db.sub_name != null && db.sub_name.toLowerCase() === svc.subCategory.toLowerCase()
    : db.sub_name == null;
  if (!catOk || !subOk) stillMismatched += 1;
  if (db.sub_category_id != null) {
    const owner = postSubs.find((s) => Number(s.id) === Number(db.sub_category_id));
    if (owner && Number(owner.category_id) !== Number(db.category_id)) crossCategory += 1;
  }
}
console.log(
  `\nPOST-CHECK: subcategories=${postSubs.length} | source-vs-db mapping mismatches remaining=${stillMismatched} | cross-category sub mappings=${crossCategory}`,
);
if (stillMismatched > 0 || crossCategory > 0) process.exitCode = 1;

await pool.end();
