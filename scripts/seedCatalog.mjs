// ==================================================
// Catalog seeder — imports the existing TNH frontend catalog and populates
// PostgreSQL (branches, categories, sub_categories, services + variants +
// service_branches).
// Run with: npm run seed:catalog
// Idempotent: matches on slug, updates names/prices, skips existing rows.
// ==================================================
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import pool, { testConnection } from "../src/config/database.js";
import { migrate } from "../src/database/migrate.js";

dotenv.config();

const SALT_ROUNDS = 10;

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

async function upsertBranches(branches) {
  for (const [slug, branch] of Object.entries(branches)) {
    await pool.query(
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
  }
}

async function upsertCategory(category) {
  const slug = category.id ?? slugify(category.name);
  const [result] = await pool.query(
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
  return result.insertId;
}

async function upsertSubCategory(categoryId, name, slug = slugify(name)) {
  await pool.query(
    `INSERT INTO sub_categories (category_id, slug, name) VALUES (?, ?, ?)
     ON CONFLICT (category_id, slug) DO UPDATE SET name = EXCLUDED.name`,
    [categoryId, slug, name],
  );
  const [rows] = await pool.query(
    `SELECT id FROM sub_categories WHERE category_id = ? AND slug = ?`,
    [categoryId, slug],
  );
  return rows[0].id;
}

async function upsertService(service, ids, displayOrder) {
  const slug = service.id ?? slugify(`${service.name}-${service.gender}`);
  const branchIds = branchLabelToIds(service.branch);
  const isActive = (service.status ?? "Active") === "Active";
  const pricingType = service.pricingType ?? "fixed";

  const [result] = await pool.query(
    `INSERT INTO services
      (slug, category_id, sub_category_id, name, audience, description, pricing_type, price, price_range, duration, image_url, display_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET
       sub_category_id = EXCLUDED.sub_category_id,
       name = EXCLUDED.name,
       audience = EXCLUDED.audience,
       description = EXCLUDED.description,
       pricing_type = EXCLUDED.pricing_type,
       price = EXCLUDED.price,
       price_range = EXCLUDED.price_range,
       duration = EXCLUDED.duration,
       image_url = EXCLUDED.image_url,
       display_order = EXCLUDED.display_order,
       is_active = EXCLUDED.is_active
     RETURNING id`,
    [
      slug,
      ids.categoryId,
      ids.subCategoryId,
      service.name,
      service.gender ?? "Unisex",
      service.description ?? null,
      pricingType,
      pricingType === "fixed" ? (service.price ?? null) : null,
      service.priceRange ?? null,
      service.duration ?? null,
      service.image ?? null,
      displayOrder,
      Boolean(isActive),
    ],
  );

  const serviceId = result.insertId;

  // Variants — replace on every run (small dataset, keeps labels/prices fresh).
  await pool.query(`DELETE FROM service_variants WHERE service_id = ?`, [
    serviceId,
  ]);
  for (const [index, variant] of (service.variants ?? []).entries()) {
    if (!variant.label) continue;
    await pool.query(
      `INSERT INTO service_variants (service_id, label, price, duration, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [
        serviceId,
        variant.label,
        Number(variant.price) || 0,
        variant.duration ?? null,
        index,
      ],
    );
  }

  // Branch availability.
  await pool.query(`DELETE FROM service_branches WHERE service_id = ?`, [
    serviceId,
  ]);
  for (const branchSlug of branchIds) {
    await pool.query(
      `INSERT INTO service_branches (service_id, branch_id)
       SELECT ?, id FROM branches WHERE slug = ?
       ON CONFLICT DO NOTHING`,
      [serviceId, branchSlug],
    );
  }

  return serviceId;
}

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

  // ---- Catalog: import straight from the existing frontend data files ----
  const { branches } = await import("../../tnh-salon/src/data/branches.js");
  const { services } = await import("../data/catalog-services.mjs");
  const { serviceCategories } = await import("../data/catalog-categories.mjs");

  // ---- Branches ----
  await upsertBranches(branches);
  const [branchRows] = await pool.query(`SELECT id, slug FROM branches`);
  const branchIdBySlug = new Map(branchRows.map((b) => [b.slug, b.id]));

  const categoryIdBySlug = new Map();
  const subCategoryIdByPair = new Map(); // `${categoryId}::${subName}`
  let subCategoryCount = 0;

  // Sub-categories are derived from the source services. Clear stale rows
  // before rebuilding them from the current frontend catalog.
  await pool.query(`DELETE FROM sub_categories`);

  for (const category of serviceCategories) {
    const categoryId = await upsertCategory(category);
    categoryIdBySlug.set(category.id, categoryId);

    // Sub-categories are derived from the services in this category.
    const subNames = new Set(
      services
        .filter(
          (service) =>
            service.categoryId === category.id && service.subCategory,
        )
        .map((service) => service.subCategory),
    );
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
      const subId = await upsertSubCategory(categoryId, name, subSlug);
      subCategoryIdByPair.set(`${category.id}::${name}`, subId);
      subCategoryCount += 1;
    }
  }

  let count = 0;
  for (const [displayOrder, service] of services.entries()) {
    await upsertService(
      service,
      {
        categoryId: categoryIdBySlug.get(service.categoryId),
        subCategoryId:
          subCategoryIdByPair.get(
            `${service.categoryId}::${service.subCategory}`,
          ) ?? null,
      },
      displayOrder,
    );
    count += 1;
  }

  const [[categoryCount]] = await pool.query(
    `SELECT COUNT(*) AS count FROM categories`,
  );
  const [[storedSubCategoryCount]] = await pool.query(
    `SELECT COUNT(*) AS count FROM sub_categories`,
  );
  const [[serviceCount]] = await pool.query(
    `SELECT COUNT(*) AS count FROM services`,
  );
  const [[duplicateServiceCount]] = await pool.query(
    `SELECT COUNT(*) AS count FROM (
       SELECT slug FROM services GROUP BY slug HAVING COUNT(*) > 1
     ) duplicates`,
  );

  console.log(`Seeded ${count} source services.`);
  console.log(`Categories: ${categoryCount.count}`);
  console.log(
    `Sub-categories: ${storedSubCategoryCount.count} (${subCategoryCount} from source)`,
  );
  console.log(`Branches: ${branchRows.length}`);
  console.log(`Services in database: ${serviceCount.count}`);
  console.log(`Duplicate service slugs: ${duplicateServiceCount.count}`);
}

seed()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("Seeding failed:", error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
