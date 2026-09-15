// ==================================================
// Catalog model — export/import of the salon catalog
// ==================================================
// Works directly on the existing tables (branches, categories,
// sub_categories, services, service_variants, service_branches) so import &
// export always round-trip the same data used by the Categories, Services and
// Branches admin screens. No parallel data model is introduced.
import pool from "../config/database.js";

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// --------------------------------------------------
// Export — reads the full catalog from MySQL
// --------------------------------------------------
export async function exportCatalog() {
  const [branchRows] = await pool.query(
    `SELECT slug, name, phone, email, address, map_url, map_embed_url,
            title, subtitle, hours, about_title, is_active
     FROM branches ORDER BY id`,
  );

  const [categoryRows] = await pool.query(
    `SELECT id, slug, name, description, icon, image, image_url, display_order, is_active
     FROM categories ORDER BY display_order, id`,
  );

  const [subRows] = await pool.query(
    `SELECT id, category_id, slug, name FROM sub_categories ORDER BY id`,
  );

  const [serviceRows] = await pool.query(
    `SELECT id, slug, category_id, sub_category_id, name, audience, description,
            pricing_type, price, price_range, duration, image, image_url,
            display_order, is_active
     FROM services ORDER BY display_order, id`,
  );

  const [variantRows] = await pool.query(
    `SELECT service_id, label, price, duration, sort_order
     FROM service_variants ORDER BY service_id, sort_order, id`,
  );

  const [linkRows] = await pool.query(
    `SELECT sb.service_id, b.slug AS branch_slug
     FROM service_branches sb
     INNER JOIN branches b ON b.id = sb.branch_id
     ORDER BY sb.service_id, b.id`,
  );

  // Lookups: DB ids -> stable identifiers (slugs) so the exported file stays
  // portable across environments (auto-increment ids differ per database).
  const subById = new Map(subRows.map((sub) => [sub.id, sub]));
  const categoryById = new Map(
    categoryRows.map((category) => [category.id, category]),
  );

  const variantsByService = new Map();
  for (const variant of variantRows) {
    if (!variantsByService.has(variant.service_id)) {
      variantsByService.set(variant.service_id, []);
    }
    variantsByService.get(variant.service_id).push({
      label: variant.label,
      price: Number(variant.price),
      ...(variant.duration ? { duration: variant.duration } : {}),
    });
  }

  const branchesByService = new Map();
  for (const link of linkRows) {
    if (!branchesByService.has(link.service_id)) {
      branchesByService.set(link.service_id, []);
    }
    branchesByService.get(link.service_id).push(link.branch_slug);
  }

  return {
    format: "tnh-salon-catalog",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      branches: branchRows.map((branch) => ({
        slug: branch.slug,
        name: branch.name,
        phone: branch.phone ?? null,
        email: branch.email ?? null,
        address: branch.address ?? null,
        mapUrl: branch.map_url ?? null,
        mapEmbedUrl: branch.map_embed_url ?? null,
        title: branch.title ?? null,
        subtitle: branch.subtitle ?? null,
        hours: branch.hours ?? null,
        aboutTitle: branch.about_title ?? null,
        isActive: branch.is_active !== 0 && branch.is_active !== false,
      })),
      categories: categoryRows.map((category) => ({
        slug: category.slug,
        name: category.name,
        description: category.description ?? null,
        icon: category.icon ?? "sparkles",
        image: category.image ?? null,
        imageUrl: category.image_url ?? null,
        displayOrder: category.display_order ?? 0,
        isActive: category.is_active !== 0 && category.is_active !== false,
        subCategories: subRows
          .filter((sub) => sub.category_id === category.id)
          .map((sub) => ({ slug: sub.slug, name: sub.name })),
      })),
      services: serviceRows.map((service) => ({
        slug: service.slug,
        categorySlug: categoryById.get(service.category_id)?.slug ?? null,
        subCategorySlug: service.sub_category_id
          ? (subById.get(service.sub_category_id)?.slug ?? null)
          : null,
        name: service.name,
        audience: service.audience ?? "Unisex",
        description: service.description ?? null,
        pricingType: service.pricing_type ?? "fixed",
        price: service.price != null ? Number(service.price) : null,
        priceRange: service.price_range ?? null,
        duration: service.duration ?? null,
        image: service.image ?? null,
        imageUrl: service.image_url ?? null,
        displayOrder: service.display_order ?? 0,
        isActive: service.is_active !== 0 && service.is_active !== false,
        variants: variantsByService.get(service.id) ?? [],
        branchSlugs: branchesByService.get(service.id) ?? [],
      })),
    },
  };
}

// --------------------------------------------------
// Import — validates the payload, then upserts into the existing tables
// --------------------------------------------------
// Identifiers are slugs (as produced by exportCatalog), so rows are matched
// by slug and updated in place; new rows are inserted. Rows with problems
// (missing category, bad pricing type, ...) are skipped and reported in the
// returned `issues` list instead of failing the whole import.
export class CatalogValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

const PRICING_TYPES = ["fixed", "size", "variant", "from"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function importCatalog(payload) {
  if (!isPlainObject(payload)) {
    throw new CatalogValidationError(
      "Invalid file. Expected a JSON catalog export.",
    );
  }

  if (payload.format !== "tnh-salon-catalog") {
    throw new CatalogValidationError(
      "Unrecognized file. Please upload a JSON file exported from this page.",
    );
  }

  const data = payload.data;
  if (!isPlainObject(data)) {
    throw new CatalogValidationError(
      "Invalid file. The export is missing its data section.",
    );
  }

  const branches = Array.isArray(data.branches) ? data.branches : [];
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const services = Array.isArray(data.services) ? data.services : [];

  if (
    categories.length === 0 &&
    services.length === 0 &&
    branches.length === 0
  ) {
    throw new CatalogValidationError(
      "The file contains no branches, categories or services to import.",
    );
  }

  const issues = [];

  // ---- Branches (upsert by slug; the two salons always exist) ----
  for (const [index, branch] of branches.entries()) {
    const slug = slugify(branch?.slug);
    const name = String(branch?.name ?? "").trim();
    if (!slug || !name) {
      issues.push(`Branches[${index}]: missing slug or name. Skipped.`);
      continue;
    }
    await pool.query(
      `INSERT INTO branches
        (slug, name, phone, email, address, map_url, map_embed_url, title, subtitle, hours, about_title, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        phone = VALUES(phone),
        email = VALUES(email),
        address = VALUES(address),
        map_url = VALUES(map_url),
        map_embed_url = VALUES(map_embed_url),
        title = VALUES(title),
        subtitle = VALUES(subtitle),
        hours = VALUES(hours),
        about_title = VALUES(about_title),
        is_active = VALUES(is_active)`,
      [
        slug,
        name,
        branch.phone ?? null,
        branch.email ?? null,
        branch.address ?? null,
        branch.mapUrl ?? null,
        branch.mapEmbedUrl ?? null,
        branch.title ?? null,
        branch.subtitle ?? null,
        branch.hours ? JSON.stringify(branch.hours) : null,
        branch.aboutTitle ?? null,
        branch.isActive === false ? 0 : 1,
      ],
    );
  }

  const [branchRows] = await pool.query(
    `SELECT id, slug FROM branches`,
  );
  const branchIdBySlug = new Map(
    branchRows.map((b) => [b.slug, Number(b.id)]),
  );

  // ---- Categories + sub-categories (upsert by slug) ----
  const categoryIdBySlug = new Map();
  const subIdByPair = new Map(); // `${categorySlug}::${subSlug}` -> id
  let importedCategories = 0;
  let importedSubCategories = 0;
  const seenCategorySlugs = new Set();

  for (const [index, category] of categories.entries()) {
    const label = `Categories[${index}]`;
    const name = String(category?.name ?? "").trim();
    const slug = slugify(category?.slug || name);
    if (!name || !slug) {
      issues.push(`${label}: name is required. Skipped.`);
      continue;
    }
    if (seenCategorySlugs.has(slug)) {
      issues.push(`${label}: duplicate category "${name}". Skipped.`);
      continue;
    }
    seenCategorySlugs.add(slug);

    await pool.query(
      `INSERT INTO categories (slug, name, description, icon, image, image_url, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        icon = VALUES(icon),
        image = VALUES(image),
        image_url = VALUES(image_url),
        display_order = VALUES(display_order),
        is_active = VALUES(is_active)`,
      [
        slug,
        name,
        category.description ?? null,
        category.icon ?? "sparkles",
        category.image ?? null,
        category.imageUrl ?? null,
        Number.isFinite(Number(category.displayOrder))
          ? Number(category.displayOrder)
          : index + 1,
        category.isActive === false ? 0 : 1,
      ],
    );

    const [rows] = await pool.query(
      `SELECT id FROM categories WHERE slug = ?`,
      [slug],
    );
    const categoryId = Number(rows[0].id);
    categoryIdBySlug.set(slug, categoryId);
    importedCategories += 1;

    const seenSubSlugs = new Set();
    const subList = Array.isArray(category.subCategories)
      ? category.subCategories
      : [];
    for (const sub of subList) {
      const subName = String(sub?.name ?? sub ?? "").trim();
      const subSlug = slugify(sub?.slug || subName);
      if (!subName || !subSlug) continue;
      if (seenSubSlugs.has(subSlug)) continue;
      seenSubSlugs.add(subSlug);

      await pool.query(
        `INSERT INTO sub_categories (category_id, slug, name) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [categoryId, subSlug, subName],
      );
      const [subRows] = await pool.query(
        `SELECT id FROM sub_categories WHERE category_id = ? AND slug = ?`,
        [categoryId, subSlug],
      );
      subIdByPair.set(`${slug}::${subSlug}`, Number(subRows[0].id));
      importedSubCategories += 1;
    }
  }

  // ---- Services (+ variants + branch availability, upsert by slug) ----
  // A service's category can come from the file or already exist in the
  // database (matches how the catalog seeder resolves categories).
  const seenServiceSlugs = new Set();
  let importedServices = 0;

  for (const [index, service] of services.entries()) {
    const label = `Services[${index}]`;
    const name = String(service?.name ?? "").trim();
    if (!name) {
      issues.push(`${label}: name is required. Skipped.`);
      continue;
    }

    const slug =
      slugify(service?.slug) ||
      slugify(`${name}-${service?.audience ?? "unisex"}`);
    if (seenServiceSlugs.has(slug)) {
      issues.push(`${label}: duplicate service "${name}". Skipped.`);
      continue;
    }

    let categoryId = null;
    const categorySlug = service?.categorySlug
      ? slugify(service.categorySlug)
      : null;
    if (categorySlug) {
      if (categoryIdBySlug.has(categorySlug)) {
        categoryId = categoryIdBySlug.get(categorySlug);
      } else {
        const [rows] = await pool.query(
          `SELECT id FROM categories WHERE slug = ?`,
          [categorySlug],
        );
        if (rows.length > 0) categoryId = Number(rows[0].id);
      }
    }
    if (!categoryId) {
      issues.push(
        `${label} ("${name}"): category "${service?.categorySlug ?? ""}" was not found. Skipped.`,
      );
      continue;
    }
    seenServiceSlugs.add(slug);

    const pricingType = PRICING_TYPES.includes(service?.pricingType)
      ? service.pricingType
      : "fixed";

    const subCategorySlug = service?.subCategorySlug
      ? slugify(service.subCategorySlug)
      : null;
    const subCategoryId = subCategorySlug
      ? (subIdByPair.get(`${categorySlug}::${subCategorySlug}`) ?? null)
      : null;

    const variants = (Array.isArray(service.variants) ? service.variants : [])
      .map((variant) => ({
        label: String(variant?.label ?? "").trim(),
        price: Number(variant?.price) || 0,
        ...(variant?.duration ? { duration: String(variant.duration) } : {}),
      }))
      .filter((variant) => variant.label);

    const branchSlugs = Array.isArray(service.branchSlugs)
      ? [...new Set(service.branchSlugs.map(slugify).filter(Boolean))]
      : [];

    await pool.query(
      `INSERT INTO services
        (slug, category_id, sub_category_id, name, audience, description, pricing_type, price, price_range, duration, image, image_url, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        category_id = VALUES(category_id),
        sub_category_id = VALUES(sub_category_id),
        audience = VALUES(audience),
        description = VALUES(description),
        pricing_type = VALUES(pricing_type),
        price = VALUES(price),
        price_range = VALUES(price_range),
        duration = VALUES(duration),
        image = VALUES(image),
        image_url = VALUES(image_url),
        display_order = VALUES(display_order),
        is_active = VALUES(is_active)`,
      [
        slug,
        categoryId,
        subCategoryId,
        name,
        String(service?.audience ?? "Unisex").trim() || "Unisex",
        service?.description ?? null,
        pricingType,
        pricingType === "fixed" || pricingType === "from"
          ? (Number(service?.price) || null)
          : null,
        service?.priceRange ?? null,
        service?.duration ?? null,
        service?.image ?? null,
        service?.imageUrl ?? null,
        Number.isFinite(Number(service?.displayOrder))
          ? Number(service.displayOrder)
          : index,
        service?.isActive === false ? 0 : 1,
      ],
    );

    const [rows] = await pool.query(`SELECT id FROM services WHERE slug = ?`, [
      slug,
    ]);
    const serviceId = Number(rows[0].id);

    await pool.query(`DELETE FROM service_variants WHERE service_id = ?`, [
      serviceId,
    ]);
    for (const [sortIndex, variant] of variants.entries()) {
      await pool.query(
        `INSERT INTO service_variants (service_id, label, price, duration, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
        [serviceId, variant.label, variant.price, variant.duration ?? null, sortIndex],
      );
    }

    await pool.query(`DELETE FROM service_branches WHERE service_id = ?`, [
      serviceId,
    ]);
    for (const branchSlug of branchSlugs) {
      const branchId = branchIdBySlug.get(branchSlug);
      if (!branchId) continue;
      await pool.query(
        `INSERT IGNORE INTO service_branches (service_id, branch_id) VALUES (?, ?)`,
        [serviceId, branchId],
      );
    }

    importedServices += 1;
  }

  return {
    branches: branchRows.length,
    categories: importedCategories,
    subCategories: importedSubCategories,
    services: importedServices,
    issues,
  };
}
