// ==================================================
// Catalog seeder — imports the existing TNH frontend catalog and populates
// PostgreSQL (branches, categories, sub_categories, services + variants +
// service_branches).
// Run with: npm run seed:catalog   (alias: npm run seed)
// Idempotent: services match on their stable slug (the catalog's `id` field),
// so re-running UPDATEs existing rows and INSERTs only genuinely new ones —
// never duplicates. Stale rows are reported, never auto-deleted.
// The whole catalog write runs inside ONE transaction: any error rolls back
// every change, so the database can never be left half-seeded.
// ==================================================
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import pool, { testConnection } from "../src/config/database.js";
import { migrate } from "../src/database/migrate.js";

dotenv.config();

const SALT_ROUNDS = 10;

// The full catalog must be present in services.js before any DB write happens.
const EXPECTED_SERVICE_COUNT = 238;

// The counters reported at the end of the run.
const stats = {
  branchesUpserted: 0,
  categoriesUpserted: 0,
  subCategoriesSynced: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  variantsInserted: 0,
  variantsUpdated: 0,
  variantsDeleted: 0,
  branchLinksInserted: 0,
  branchLinksRemoved: 0,
  staleServices: [],
  warnings: [],
};

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function stableSlugSuffix(value) {
  let hash = 0;
  for (const character of String(value)) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function branchLabelToIds(branchLabel) {
  switch (branchLabel) {
    case "Both branches":
      return ["indiranagar", "sarjapur-road"];
    case "Indiranagar":
      return ["indiranagar"];
    case "Sarjapura Road":
    case "Sarjapur Road":
      return ["sarjapur-road"];
    default:
      return [];
  }
}

// ==================================================
// Validation — every check runs BEFORE the transaction opens. Any failure
// stops the seed before the database is touched.
// ==================================================
function validateCatalog(services, serviceCategories) {
  const errors = [];

  if (!Array.isArray(services) || services.length === 0) {
    errors.push("services.js did not import successfully or is empty");
    return errors;
  }
  if (services.length !== EXPECTED_SERVICE_COUNT) {
    errors.push(
      `Expected ${EXPECTED_SERVICE_COUNT} services but found ${services.length}`,
    );
  }

  // Duplicate service IDs.
  const idCounts = new Map();
  for (const service of services) {
    idCounts.set(service.id, (idCounts.get(service.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push(`Duplicate service id: ${id} (x${count})`);
  }

  // Required fields.
  services.forEach((service, index) => {
    if (!service.id) errors.push(`Service #${index}: missing id`);
    if (!service.name || !String(service.name).trim())
      errors.push(`${service.id || `#${index}`}: missing name`);
    if (!service.categoryId) errors.push(`${service.id}: missing categoryId`);
    if (!service.gender) errors.push(`${service.id}: missing gender`);
    if (!["Men", "Women", "Unisex", "Boys", "Girls", "Women Only"].includes(
      service.gender,
    )) {
      errors.push(`${service.id}: unexpected gender "${service.gender}"`);
    }
    if (!["Active", "Inactive"].includes(service.status ?? "Active")) {
      errors.push(`${service.id}: unexpected status "${service.status}"`);
    }
    if (!["fixed", "size", "variant"].includes(service.pricingType)) {
      errors.push(`${service.id}: unexpected pricingType "${service.pricingType}"`);
    }
    if (!["Both branches", "Indiranagar", "Sarjapura Road", "Sarjapur Road"].includes(
      service.branch,
    )) {
      errors.push(`${service.id}: unknown branch "${service.branch}"`);
    }
  });

  // Pricing + variants.
  for (const service of services) {
    const variants = service.variants ?? [];
    if (service.pricingType === "fixed") {
      if (service.price == null || Number.isNaN(Number(service.price))) {
        errors.push(`${service.id}: fixed pricing requires a valid price`);
      }
      if (variants.length > 0) {
        errors.push(
          `${service.id}: fixed pricing must not carry variants (found ${variants.length})`,
        );
      }
    } else {
      if (variants.length === 0) {
        errors.push(`${service.id}: ${service.pricingType} pricing requires variants`);
      }
      if (service.price != null) {
        errors.push(`${service.id}: ${service.pricingType} pricing must not set price`);
      }
    }
    const labels = variants.map((variant) => String(variant.label ?? "").trim());
    labels.forEach((label, index) => {
      if (!label) errors.push(`${service.id}: variant #${index} has no label`);
      if (
        variants[index].price == null ||
        Number.isNaN(Number(variants[index].price))
      ) {
        errors.push(`${service.id}: variant "${label}" has no valid price`);
      }
    });
    const unique = new Set(labels);
    if (unique.size !== labels.length) {
      errors.push(`${service.id}: duplicate variant labels (${labels.join(", ")})`);
    }
  }

  // Category references must exist in the category bridge file.
  const categoryIds = new Set(serviceCategories.map((category) => category.id));
  for (const service of services) {
    if (!categoryIds.has(service.categoryId)) {
      errors.push(`${service.id}: unknown categoryId "${service.categoryId}"`);
    }
  }

  if (errors.length > 0) {
    console.error(`\nCatalog validation FAILED (${errors.length} problem(s)):`);
    for (const error of errors) console.error(`  - ${error}`);
    console.error("\nStopping BEFORE any database modification.");
    process.exitCode = 1;
  }
  return errors;
}

// ==================================================
// Upserts — all run against ONE dedicated transaction client.
// ==================================================
async function upsertBranches(client, branches) {
  for (const [slug, branch] of Object.entries(branches)) {
    const [result] = await client.query(
      `INSERT INTO branches
        (slug, name, phone, email, address, map_url, map_embed_url, title, subtitle, hours, about_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        address = EXCLUDED.address,
        map_url = EXCLUDED.map_url,
        map_embed_url = EXCLUDED.map_embed_url,
        title = EXCLUDED.title,
        subtitle = EXCLUDED.subtitle,
        hours = EXCLUDED.hours,
        about_title = EXCLUDED.about_title`,
      [
        slug,
        branch.name,
        branch.phone ?? null,
        branch.email ?? null,
        branch.address ?? null,
        branch.mapUrl ?? null,
        branch.mapEmbedUrl ?? null,
        branch.title ?? null,
        branch.subtitle ?? null,
        branch.hours ? JSON.stringify(branch.hours) : null,
        branch.aboutTitle ?? null,
      ],
    );
    stats.branchesUpserted += 1;
    void result;
  }
}

async function upsertCategory(client, category) {
  const slug = category.id ?? slugify(category.name);
  const [result] = await client.query(
    `INSERT INTO categories (slug, name, description, icon)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       icon = EXCLUDED.icon
     RETURNING id`,
    [
      slug,
      category.name,
      category.description ?? null,
      category.icon ?? "sparkles",
    ],
  );
  stats.categoriesUpserted += 1;
  return result.insertId;
}

async function upsertSubCategory(client, categoryId, name, slug = slugify(name)) {
  await client.query(
    `INSERT INTO sub_categories (category_id, slug, name) VALUES (?, ?, ?)
     ON CONFLICT (category_id, slug) DO UPDATE SET name = EXCLUDED.name`,
    [categoryId, slug, name],
  );
  const [rows] = await client.query(
    `SELECT id FROM sub_categories WHERE category_id = ? AND slug = ?`,
    [categoryId, slug],
  );
  return rows[0].id;
}

// True diff-sync of one service's variants: insert missing, update changed
// (label/price/duration/order), delete removed. (service_id, label) is the
// match key, so re-running the seed never duplicates variants.
async function syncVariants(client, serviceId, sourceVariants) {
  const incoming = (sourceVariants ?? [])
    .filter((variant) => variant?.label)
    .map((variant, index) => ({
      label: String(variant.label).trim(),
      price: Number(variant.price) || 0,
      duration: variant.duration ?? null,
      sortOrder: index,
    }));

  const [existingRows] = await client.query(
    `SELECT id, label, price, duration, sort_order
     FROM service_variants WHERE service_id = ?`,
    [serviceId],
  );
  const existingByLabel = new Map(
    existingRows.map((row) => [row.label, row]),
  );

  const seenLabels = new Set();
  for (const variant of incoming) {
    seenLabels.add(variant.label);
    const existing = existingByLabel.get(variant.label);
    if (!existing) {
      await client.query(
        `INSERT INTO service_variants (service_id, label, price, duration, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
        [serviceId, variant.label, variant.price, variant.duration, variant.sortOrder],
      );
      stats.variantsInserted += 1;
    } else {
      const samePrice = Number(existing.price) === variant.price;
      const sameDuration = (existing.duration ?? null) === variant.duration;
      const sameOrder = Number(existing.sort_order) === variant.sortOrder;
      if (!samePrice || !sameDuration || !sameOrder) {
        await client.query(
          `UPDATE service_variants
           SET price = ?, duration = ?, sort_order = ?
           WHERE id = ?`,
          [variant.price, variant.duration, variant.sortOrder, existing.id],
        );
        stats.variantsUpdated += 1;
      }
    }
  }

  for (const [label, row] of existingByLabel) {
    if (!seenLabels.has(label)) {
      await client.query(`DELETE FROM service_variants WHERE id = ?`, [row.id]);
      stats.variantsDeleted += 1;
    }
  }
}

// True diff-sync of one service's branch links. (service_id, branch_id) is the
// primary key of service_branches, so duplicates are impossible at the schema
// level; this only adds missing links and removes links the source dropped.
async function syncBranchLinks(client, serviceId, branchSlugs) {
  const [existingRows] = await client.query(
    `SELECT sb.branch_id, b.slug
     FROM service_branches sb
     INNER JOIN branches b ON b.id = sb.branch_id
     WHERE sb.service_id = ?`,
    [serviceId],
  );
  const existingSlugs = new Set(existingRows.map((row) => row.slug));
  const wantedSlugs = new Set(branchSlugs);

  for (const slug of wantedSlugs) {
    if (!existingSlugs.has(slug)) {
      await client.query(
        `INSERT INTO service_branches (service_id, branch_id)
         SELECT ?, id FROM branches WHERE slug = ?`,
        [serviceId, slug],
      );
      stats.branchLinksInserted += 1;
    }
  }
  for (const row of existingRows) {
    if (!wantedSlugs.has(row.slug)) {
      await client.query(
        `DELETE FROM service_branches WHERE service_id = ? AND branch_id = ?`,
        [serviceId, row.branch_id],
      );
      stats.branchLinksRemoved += 1;
    }
  }
}

async function syncService(client, service, ids, displayOrder) {
  const slug = service.id; // stable catalog id == services.slug (UNIQUE)
  const branchIds = branchLabelToIds(service.branch);
  const isActive = (service.status ?? "Active") === "Active";
  const pricingType = service.pricingType ?? "fixed";
  const price = pricingType === "fixed" ? (service.price ?? null) : null;

  // Fields shared by INSERT and UPDATE, so both paths stay in lockstep.
  const upsertColumns = `
      sub_category_id, name, audience, description, pricing_type, price,
      price_range, duration, image_url, display_order, is_active`;
  const upsertValues = [
    ids.subCategoryId,
    service.name,
    service.gender ?? "Unisex",
    service.description ?? null,
    pricingType,
    price,
    service.priceRange ?? null,
    service.duration ?? null,
    service.image ?? null,
    displayOrder,
    Boolean(isActive),
  ];

  const [existingRows] = await client.query(
    `SELECT id, sub_category_id, name, audience, description, pricing_type,
            price, price_range, duration, image_url, display_order, is_active
     FROM services WHERE slug = ? LIMIT 1`,
    [slug],
  );

  let serviceId;
  if (existingRows.length === 0) {
    const [result] = await client.query(
      `INSERT INTO services
        (slug, ${upsertColumns})
       VALUES (?, ${upsertColumns.split(",").map(() => "?").join(", ")})
       RETURNING id`,
      [slug, ...upsertValues],
    );
    serviceId = result.insertId;
    stats.inserted += 1;
  } else {
    serviceId = existingRows[0].id;
    const row = existingRows[0];
    const identical =
      row.sub_category_id === ids.subCategoryId &&
      row.name === service.name &&
      row.audience === (service.gender ?? "Unisex") &&
      row.description === (service.description ?? null) &&
      row.pricing_type === pricingType &&
      // Null-aware price compare: DECIMAL arrives as a string from pg, and
      // Number(null) === 0 would wrongly treat null and 0 as identical.
      ((row.price === null && price === null) ||
        (row.price !== null &&
          price !== null &&
          Number(row.price) === Number(price))) &&
      row.price_range === (service.priceRange ?? null) &&
      row.duration === (service.duration ?? null) &&
      row.image_url === (service.image ?? null) &&
      Number(row.display_order) === displayOrder &&
      row.is_active === Boolean(isActive);
    if (!identical) {
      await client.query(
        `UPDATE services SET
           sub_category_id = ?, name = ?, audience = ?, description = ?,
           pricing_type = ?, price = ?, price_range = ?, duration = ?,
           image_url = ?, display_order = ?, is_active = ?, updated_at = NOW()
         WHERE id = ?`,
        [...upsertValues, serviceId],
      );
      stats.updated += 1;
    } else {
      stats.unchanged += 1;
    }
  }

  await syncVariants(client, serviceId, service.variants);
  await syncBranchLinks(client, serviceId, branchIds);
  return serviceId;
}

// ==================================================
// Main
// ==================================================
async function seed() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error(
      "ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env",
    );
    process.exitCode = 1;
    return;
  }

  await testConnection();
  await migrate();

  // ---- Source-of-truth imports (validated BEFORE any DB write) ----
  const { branches } = await import("../../tnh-salon/src/data/branches.js");
  const { services } = await import("../data/catalog-services.mjs");
  const { serviceCategories } = await import("../data/catalog-categories.mjs");

  if (validateCatalog(services, serviceCategories).length > 0) return;

  // ---- Admin (same behavior as seed:admin) ----
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const [existingAdmins] = await pool.query(
    `SELECT id FROM admins WHERE email = ?`,
    [email],
  );
  if (existingAdmins.length === 0) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
    await pool.query(
      `INSERT INTO admins (name, email, password_hash, role, is_active) VALUES (?, ?, ?, 'admin', true)`,
      [ADMIN_NAME, email, passwordHash],
    );
    console.log(`Admin created: ${email}`);
  } else {
    console.log(`Admin already exists: ${email}`);
  }

  // ---- Branches (small lookup table, safe to upsert outside the tx) ----
  await upsertBranches(pool, branches);
  const [branchRows] = await pool.query(`SELECT id, slug FROM branches`);
  const branchIdBySlug = new Map(branchRows.map((b) => [b.slug, b.id]));

  // Pre-resolve category ids (upsert, idempotent).
  const categoryIdBySlug = new Map();
  for (const category of serviceCategories) {
    categoryIdBySlug.set(category.id, await upsertCategory(pool, category));
  }

  // Pre-resolve sub-categories from the source services (upsert-only —
  // no DELETE, so nothing is destroyed if the run fails mid-way).
  const subCategoryIdByPair = new Map();
  for (const category of serviceCategories) {
    const categoryId = categoryIdBySlug.get(category.id);
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
      const names = namesBySlug.get(baseSlug) ?? [];
      names.push(name);
      namesBySlug.set(baseSlug, names);
    }
    for (const name of subNames) {
      const baseSlug = slugify(name);
      const collides = (namesBySlug.get(baseSlug) ?? []).length > 1;
      const subSlug = collides
        ? `${baseSlug}-${stableSlugSuffix(name)}`
        : baseSlug;
      subCategoryIdByPair.set(
        `${category.id}::${name}`,
        await upsertSubCategory(pool, categoryId, name, subSlug),
      );
      stats.subCategoriesSynced += 1;
    }
  }

  // ==================================================
  // ONE transaction for the entire catalog sync. Any error → full ROLLBACK.
  // ==================================================
  const client = await pool.getConnection();
  try {
    await client.beginTransaction();

    // Pre-compute stale services (in DB, absent from source) — REPORT ONLY.
    const [dbSlugs] = await client.query(`SELECT slug FROM services`);
    const sourceSlugs = new Set(services.map((service) => service.id));
    stats.staleServices = dbSlugs
      .map((row) => row.slug)
      .filter((slug) => !sourceSlugs.has(slug));

    for (const [displayOrder, service] of services.entries()) {
      await syncService(
        client,
        service,
        {
          categoryId: categoryIdBySlug.get(service.categoryId),
          subCategoryId: subCategoryIdByPair.get(
            `${service.categoryId}::${service.subCategory}`,
          ),
        },
        displayOrder,
      );
    }

    await client.commit();
  } catch (error) {
    await client.rollback();
    console.error("Transaction rolled back — database unchanged:", error.message);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
  }

  // ==================================================
  // Verification — read-only queries after commit.
  // ==================================================
  const q = (sql, params) =>
    pool.query(sql, params).then((r) => r[0]);
  const [[serviceCount]] = [
    await q(`SELECT COUNT(*) AS c FROM services`),
  ];
  const [[categoryCount]] = [await q(`SELECT COUNT(*) AS c FROM categories`)];
  const [[storedSubCategoryCount]] = [
    await q(`SELECT COUNT(*) AS c FROM sub_categories`),
  ];
  const [[duplicateServiceCount]] = [
    await q(
      `SELECT COUNT(*) AS c FROM (
         SELECT slug FROM services GROUP BY slug HAVING COUNT(*) > 1
       ) duplicates`,
    ),
  ];
  const [[orphanVariants]] = [
    await q(
      `SELECT COUNT(*) AS c FROM service_variants sv
       LEFT JOIN services s ON s.id = sv.service_id WHERE s.id IS NULL`,
    ),
  ];
  const [[orphanLinks]] = [
    await q(
      `SELECT COUNT(*) AS c FROM service_branches sb
       LEFT JOIN services s ON s.id = sb.service_id
       LEFT JOIN branches b ON b.id = sb.branch_id
       WHERE s.id IS NULL OR b.id IS NULL`,
    ),
  ];
  const audienceRows = await q(
    `SELECT audience, COUNT(*) AS c FROM services GROUP BY audience ORDER BY c DESC`,
  );
  const [[fixedCount]] = [
    await q(
      `SELECT COUNT(*) AS c FROM services WHERE pricing_type = 'fixed' AND price IS NOT NULL`,
    ),
  ];
  const [[sizeCount]] = [
    await q(
      `SELECT COUNT(*) AS c FROM services s
       WHERE s.pricing_type = 'size'
         AND (SELECT COUNT(*) FROM service_variants v WHERE v.service_id = s.id) >= 2`,
    ),
  ];
  const [[nullSubAfter]] = [
    await q(
      `SELECT COUNT(*) AS c FROM services WHERE sub_category_id IS NULL`,
    ),
  ];

  console.log(`\n=== Seed complete ===`);
  console.log(`Source services:            ${services.length}`);
  console.log(`Services in database:       ${serviceCount.c}`);
  console.log(`Inserted:                   ${stats.inserted}`);
  console.log(`Updated:                    ${stats.updated}`);
  console.log(`Unchanged:                  ${stats.unchanged}`);
  console.log(
    `Variants inserted/updated/deleted: ${stats.variantsInserted}/${stats.variantsUpdated}/${stats.variantsDeleted}`,
  );
  console.log(
    `Branch links inserted/removed:     ${stats.branchLinksInserted}/${stats.branchLinksRemoved}`,
  );
  console.log(`Categories:                 ${categoryCount.c}`);
  console.log(`Sub-categories:             ${storedSubCategoryCount.c} (${stats.subCategoriesSynced} from source)`);
  console.log(`Duplicate service slugs:    ${duplicateServiceCount.c}`);
  console.log(`Orphan variants/links:      ${orphanVariants.c}/${orphanLinks.c}`);
  console.log(
    `Audience:                   ${audienceRows.map((r) => `${r.audience}=${r.c}`).join(", ")}`,
  );
  console.log(`Fixed-price services:       ${fixedCount.c}`);
  console.log(`Multi-variant (S/M/L etc.): ${sizeCount.c}`);
  console.log(`Services w/o sub-category:  ${nullSubAfter.c}`);
  if (stats.staleServices.length > 0) {
    console.log(
      `\nSTALE DATABASE SERVICES (not auto-deleted — decide separately):\n  ${stats.staleServices.join("\n  ")}`,
    );
  } else {
    console.log(`Stale database services:    0`);
  }
}

seed()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("Seeding failed:", error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
