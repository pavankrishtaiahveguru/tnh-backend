// ==================================================
// Backfill: services.sub_category_id from the source catalog
// ==================================================
// The seeder's original ON CONFLICT clause never updated sub_category_id on
// re-seed, so live services kept sub_category_id = NULL even though every
// service in the source catalog (tnh-salon/src/data/services.js) carries a
// subCategory. This one-off, IDEMPOTENT script re-links every service by
// (category slug + exact subcategory name), reproducing the seeder's slug
// derivation exactly (including its collision suffix).
//
// Run with: npm run backfill:subcategories
// Only the sub-category links are touched — no other columns, no schema
// changes, no record creation/deletion.
// ==================================================
import dotenv from "dotenv";
import pool, { testConnection } from "../src/config/database.js";

dotenv.config();

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Identical to seedCatalog.mjs so collision slugs match the seeded rows.
function stableSlugSuffix(value) {
  let hash = 0;
  for (const character of String(value)) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return hash.toString(36);
}

async function backfill() {
  await testConnection();

  const { services } = await import("../data/catalog-services.mjs");
  const { serviceCategories } = await import("../data/catalog-categories.mjs");

  // `${categorySlug}::${subName}` -> sub_category slug (seeder rules).
  const subSlugByPair = new Map();
  for (const category of serviceCategories) {
    const subNames = [
      ...new Set(
        services
          .filter(
            (service) =>
              service.categoryId === category.id && service.subCategory,
          )
          .map((service) => service.subCategory),
      ),
    ];
    const namesBySlug = new Map();
    for (const name of subNames) {
      const baseSlug = slugify(name);
      namesBySlug.set(baseSlug, (namesBySlug.get(baseSlug) ?? []).concat(name));
    }
    for (const name of subNames) {
      const baseSlug = slugify(name);
      const collides = (namesBySlug.get(baseSlug) ?? []).length > 1;
      const subSlug = collides
        ? `${baseSlug}-${stableSlugSuffix(name)}`
        : baseSlug;
      subSlugByPair.set(`${category.id}::${name}`, subSlug);
    }
  }

  // Live sub_categories: `${category_id}::${slug}` -> id.
  const [subRows] = await pool.query(
    `SELECT id, category_id, slug FROM sub_categories`,
  );
  const subIdByCategoryAndSlug = new Map(
    subRows.map((row) => [`${row.category_id}::${row.slug}`, Number(row.id)]),
  );

  // Live services: `${category_slug}::${service_slug}` -> row.
  const [serviceRows] = await pool.query(
    `SELECT s.id, s.slug, s.sub_category_id, s.category_id, c.slug AS category_slug
     FROM services s
     INNER JOIN categories c ON c.id = s.category_id`,
  );
  const serviceByCategoryAndSlug = new Map(
    serviceRows.map((row) => [`${row.category_slug}::${row.slug}`, row]),
  );

  let linked = 0;
  let alreadyLinked = 0;
  const missingSub = new Set();
  const missingService = new Set();

  for (const service of services) {
    const row = serviceByCategoryAndSlug.get(
      `${service.categoryId}::${service.id}`,
    );
    if (!row) {
      missingService.add(`${service.categoryId}/${service.id}`);
      continue;
    }

    const subSlug = service.subCategory
      ? subSlugByPair.get(`${service.categoryId}::${service.subCategory}`)
      : null;
    if (service.subCategory && !subSlug) {
      missingSub.add(`${service.categoryId}/${service.subCategory}`);
      continue;
    }

    const subId = subSlug
      ? subIdByCategoryAndSlug.get(`${row.category_id}::${subSlug}`)
      : null;
    if (service.subCategory && subId == null) {
      missingSub.add(`${service.categoryId}/${service.subCategory} (no row)`);
      continue;
    }

    if (Number(row.sub_category_id ?? 0) === Number(subId ?? 0)) {
      alreadyLinked += 1;
      continue;
    }

    await pool.query(`UPDATE services SET sub_category_id = ? WHERE id = ?`, [
      subId,
      row.id,
    ]);
    linked += 1;
  }

  const [[nullsLeft]] = await pool.query(
    `SELECT COUNT(*) AS count FROM services WHERE sub_category_id IS NULL`,
  );
  console.log(`Services updated: ${linked}`);
  console.log(`Already correct: ${alreadyLinked}`);
  console.log(`Services still NULL after run: ${nullsLeft.count}`);
  if (missingSub.size > 0) {
    console.warn(`Missing sub_categories rows for:`);
    for (const entry of missingSub) console.warn(`  - ${entry}`);
  }
  if (missingService.size > 0) {
    console.warn(`Source services not found in DB:`);
    for (const entry of missingService) console.warn(`  - ${entry}`);
  }
}

backfill()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("Backfill failed:", error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
