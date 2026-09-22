// ==================================================
// Service model — raw SQL queries for services + variants + branches
// ==================================================
import pool from "../config/database.js";

const SERVICE_SELECT = `
  SELECT
    s.id,
    s.slug,
    s.name,
    s.category_id,
    c.slug AS category_slug,
    c.name AS category_name,
    s.sub_category_id,
    sc.slug AS subcategory_slug,
    sc.name AS subcategory_name,
    s.audience,
    s.description,
    s.pricing_type,
    s.price,
    s.price_range,
    s.duration,
    s.image,
    s.image_url,
    s.display_order,
    s.is_active,
    s.created_at,
    s.updated_at
  FROM services s
  INNER JOIN categories c ON c.id = s.category_id
  LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
`;

// Attaches variants + branch ids to service rows (batched, no N+1).
async function hydrateServices(rows) {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(", ");

  const [variantRows] = await pool.query(
    `SELECT id, service_id, label, price, duration, sort_order
     FROM service_variants
     WHERE service_id IN (${placeholders})
     ORDER BY sort_order, id`,
    ids,
  );

  const [branchRows] = await pool.query(
    `SELECT sb.service_id, sb.branch_id, b.slug AS branch_slug
     FROM service_branches sb
     INNER JOIN branches b ON b.id = sb.branch_id
     WHERE sb.service_id IN (${placeholders})`,
    ids,
  );

  const variantsByService = new Map();
  for (const variant of variantRows) {
    if (!variantsByService.has(variant.service_id)) {
      variantsByService.set(variant.service_id, []);
    }
    variantsByService.get(variant.service_id).push({
      id: variant.id,
      label: variant.label,
      price: Number(variant.price),
      ...(variant.duration ? { duration: variant.duration } : {}),
    });
  }

  const branchesByService = new Map();
  for (const branch of branchRows) {
    if (!branchesByService.has(branch.service_id)) {
      branchesByService.set(branch.service_id, []);
    }
    branchesByService.get(branch.service_id).push(branch.branch_slug);
  }

  return rows.map((row) => ({
    ...row,
    price: row.price != null ? Number(row.price) : null,
    variants: variantsByService.get(row.id) ?? [],
    branch_ids: branchesByService.get(row.id) ?? [],
  }));
}

// Whitelisted sort options for the paginated public listing (Phase 8).
// Never build ORDER BY from raw request input — this map is the only source.
// Every option ends with a unique tiebreaker (s.id) so ordering is
// deterministic across LIMIT/OFFSET pages — without it, equal-keyed rows can
// shift between page 1 and page 2 when "View More" appends.
const SORT_OPTIONS = {
  menu: "s.display_order ASC, s.name ASC, s.id ASC", // default catalog order
  nameAsc: "s.name ASC, s.id ASC",
  nameDesc: "s.name DESC, s.id ASC",
  priceAsc: "COALESCE(LEAST(s.price, effective_min_price), s.price, effective_min_price) ASC NULLS LAST, s.display_order ASC, s.id ASC",
  priceDesc: "COALESCE(LEAST(s.price, effective_min_price), s.price, effective_min_price) DESC NULLS LAST, s.display_order ASC, s.id ASC",
};

const SORT_DEFAULT = "menu";

export function resolveSort(sortParam) {
  return SORT_OPTIONS[sortParam] ?? SORT_OPTIONS[SORT_DEFAULT];
}

// GET /api/services — supports search/category/subCategory/branch/audience/status filters.
export async function findServices(filters = {}) {
  const { conditions, values } = buildServiceConditions(filters);

  const whereClause =
    conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const [rows] = await pool.query(
    `${SERVICE_SELECT}${whereClause} ORDER BY s.display_order, s.name`,
    values,
  );
  return hydrateServices(rows);
}

// Unfiltered COUNT(*) of active services — the catalog total shown by the
// Services page hero, which must never change with category/subCategory/
// branch/audience/search filters. "Active" uses the app's existing status
// definition (status === "Active" → s.is_active = TRUE in
// buildServiceConditions). One lightweight query, no rows returned.
export async function countActiveServices() {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM services WHERE is_active = TRUE`,
  );
  return Number(rows[0]?.count ?? 0);
}

// Public gender filter: "Men"/"Women" also include Unisex services (a
// Unisex service is bookable by either audience). Single source of truth so
// this rule is applied once, everywhere audience filtering happens —
// findServices, findServicesPage, and the sub-category facet-count query all
// go through buildServiceConditions below.
const AUDIENCE_FILTER_MAP = {
  Men: ["Men", "Unisex"],
  Women: ["Women", "Unisex"],
};

function resolveAudienceValues(audience) {
  return AUDIENCE_FILTER_MAP[audience] ?? [audience];
}

// Shared WHERE builder for both paginated and non-paginated listing queries.
// NOTE: price conditions reference effective_min_price, produced by the
// LEFT JOIN LATERAL in queries that include it (findServicesPage). The plain
// findServices() never passes price filters, so this stays safe.
function buildServiceConditions(filters = {}) {
  const conditions = [];
  const values = [];

  if (filters.search) {
    // Parameterized ILIKE — never string-concatenate user input into SQL.
    conditions.push(`(s.name ILIKE ? OR c.name ILIKE ? OR sc.name ILIKE ?)`);
    const term = `%${filters.search}%`;
    values.push(term, term, term);
  }
  if (filters.categorySlug) {
    conditions.push(`c.slug = ?`);
    values.push(filters.categorySlug);
  }
  if (filters.subCategorySlug || filters.subCategoryName) {
    // The public page's chips carry the sub-category NAME (existing URL
    // contract); slugs are still accepted for API callers that use them.
    if (filters.subCategorySlug && filters.subCategoryName) {
      conditions.push(`(sc.slug = ? OR sc.name = ?)`);
      values.push(filters.subCategorySlug, filters.subCategoryName);
    } else if (filters.subCategoryName) {
      conditions.push(`sc.name = ?`);
      values.push(filters.subCategoryName);
    } else {
      conditions.push(`sc.slug = ?`);
      values.push(filters.subCategorySlug);
    }
  }
  if (filters.audience) {
    const audienceValues = resolveAudienceValues(filters.audience);
    conditions.push(
      `s.audience IN (${audienceValues.map(() => "?").join(", ")})`,
    );
    values.push(...audienceValues);
  }
  if (filters.status === "Active") {
    conditions.push(`s.is_active = TRUE`);
  } else if (filters.status === "Inactive") {
    conditions.push(`s.is_active = FALSE`);
  }
  if (filters.branchSlug) {
    if (filters.branchSlug === "both") {
      // "Both branches" = available at either branch (per existing business
      // rule). EXISTS keeps results duplicate-free when a service is linked
      // to both branches.
      conditions.push(
        `EXISTS (
           SELECT 1 FROM service_branches sb
           INNER JOIN branches b ON b.id = sb.branch_id
           WHERE sb.service_id = s.id AND b.slug IN ('indiranagar', 'sarjapur-road')
         )`,
      );
    } else {
      conditions.push(
        `EXISTS (
           SELECT 1 FROM service_branches sb
           INNER JOIN branches b ON b.id = sb.branch_id
           WHERE sb.service_id = s.id AND b.slug = ?
         )`,
      );
      values.push(filters.branchSlug);
    }
  }
  if (filters.priceMin !== undefined && filters.priceMin !== null) {
    // Effective price = the lower of fixed/from price and cheapest variant.
    conditions.push(
      `COALESCE(LEAST(s.price, effective_min_price), s.price, effective_min_price) >= ?`,
    );
    values.push(filters.priceMin);
  }
  if (filters.priceMax !== undefined && filters.priceMax !== null) {
    conditions.push(
      `COALESCE(LEAST(s.price, effective_min_price), s.price, effective_min_price) <= ?`,
    );
    values.push(filters.priceMax);
  }

  return { conditions, values };
}

// Paginated public listing (Phase 5). A LEFT JOIN LATERAL computes each
// service's cheapest variant price once, so pagination, the total count
// (COUNT(*) OVER — avoids a second COUNT round-trip), price filtering and
// price sorting all work off the same value. Rows are then hydrated in
// batch (2 more queries), keeping a fixed query count regardless of page
// size. When price filters/sort are unused, the LATERAL is omitted — unless
// facet counts are requested with price filters, which also need it.
export async function findServicesPage(filters = {}) {
  const maxLimit = Number(filters.maxLimit) || 50;
  const limit = Math.min(Math.max(1, Number(filters.limit) || 24), maxLimit);
  const requestedPage = Math.max(1, Number(filters.page) || 1);

  const { conditions, values } = buildServiceConditions(filters);
  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const usesPrice =
    filters.priceMin != null ||
    filters.priceMax != null ||
    filters.sort === "priceAsc" ||
    filters.sort === "priceDesc" ||
    // Facet counts reuse the price conditions; keep the alias available.
    (filters.includeFacets &&
      (filters.priceMin != null || filters.priceMax != null));

  const lateralJoin = usesPrice
    ? `
    LEFT JOIN LATERAL (
      SELECT MIN(v.price) AS effective_min_price
      FROM service_variants v
      WHERE v.service_id = s.id
    ) vp ON TRUE`
    : "";

  const sql = `
    SELECT
      s.id, s.slug, s.name, s.category_id,
      c.slug AS category_slug, c.name AS category_name,
      s.sub_category_id, sc.slug AS subcategory_slug, sc.name AS subcategory_name,
      s.audience, s.description, s.pricing_type, s.price, s.price_range,
      s.duration, s.image, s.image_url, s.display_order, s.is_active,
      s.created_at, s.updated_at,
      ${usesPrice ? "vp.effective_min_price," : ""}
      COUNT(*) OVER() AS total_count,
      -- Variants + branch slugs aggregated inline so the whole page resolves
      -- in ONE network round-trip (the dominant cost against Neon from this
      -- environment). Prices arrive as strings (DECIMAL) and are converted
      -- below alongside the existing hydration mapping.
      (
        SELECT COALESCE(json_agg(v ORDER BY v.sort_order, v.id), '[]'::json)
        FROM (
          SELECT id, label, price, duration, sort_order
          FROM service_variants v
          WHERE v.service_id = s.id
          ORDER BY v.sort_order, v.id
        ) v
      ) AS variants_json,
      (
        SELECT COALESCE(json_agg(b.slug), '[]'::json)
        FROM service_branches sb
        INNER JOIN branches b ON b.id = sb.branch_id
        WHERE sb.service_id = s.id
      ) AS branch_ids_json
    FROM services s
    INNER JOIN categories c ON c.id = s.category_id
    LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
    ${lateralJoin}
    ${whereClause}
    ORDER BY ${resolveSort(filters.sort)}
    LIMIT ? OFFSET ?
  `;

  values.push(limit, (requestedPage - 1) * limit);
  const [rows] = await pool.query(sql, values);

  // COUNT(*) OVER() repeats the filtered total on every row; empty result
  // means the page is beyond the end — return the real total via one COUNT.
  let total = rows.length > 0 ? Number(rows[0].total_count) : null;
  if (total === null) {
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM services s
       INNER JOIN categories c ON c.id = s.category_id
       LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
       ${lateralJoin}
       ${whereClause}`,
      values.slice(0, values.length - 2),
    );
    total = Number(countRows[0]?.total ?? 0);
  }

  // Inline hydration from the json_agg columns — no extra queries, so the
  // whole page (rows + variants + branches + total) is ONE round-trip.
  const hydrated = rows.map((row) => ({
    ...row,
    price: row.price != null ? Number(row.price) : null,
    variants: (row.variants_json ?? []).map((variant) => ({
      id: variant.id,
      label: variant.label,
      price: Number(variant.price),
      ...(variant.duration ? { duration: variant.duration } : {}),
    })),
    branch_ids: row.branch_ids_json ?? [],
    variants_json: undefined,
    branch_ids_json: undefined,
  }));

  // Facet counts for the sub-category chips (Phase 7). One extra grouped
  // query, only when a category is selected; it reuses every filter EXCEPT
  // the sub-category itself so all chips stay clickable with real counts.
  let subCategories = null;
  if (filters.includeFacets && filters.categorySlug) {
    const { conditions: facetConditions, values: facetValues } =
      buildServiceConditions({
        ...filters,
        subCategorySlug: undefined,
        subCategoryName: undefined,
      });
    const facetWhere =
      facetConditions.length > 0
        ? `WHERE ${facetConditions.join(" AND ")} AND sc.id IS NOT NULL`
        : "WHERE sc.id IS NOT NULL";
    // Price conditions reference effective_min_price — include the same
    // LATERAL when price filters are active.
    const [facetRows] = await pool.query(
      `SELECT sc.name, COUNT(*) AS count
       FROM services s
       INNER JOIN categories c ON c.id = s.category_id
       LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
       ${usesPrice ? lateralJoin : ""}
       ${facetWhere}
       GROUP BY sc.name
       ORDER BY sc.name`,
      facetValues,
    );
    subCategories = facetRows.map((row) => ({
      name: row.name,
      count: Number(row.count),
    }));
  }

  return {
    services: hydrated,
    subCategories,
    pagination: buildPagination(requestedPage, limit, total),
  };
}

function buildPagination(page, limit, total) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export async function findServiceById(id) {
  const [rows] = await pool.query(`${SERVICE_SELECT} WHERE s.id = ? LIMIT 1`, [
    id,
  ]);
  const hydrated = await hydrateServices(rows);
  return hydrated[0] ?? null;
}

export async function findServiceBySlug(slug) {
  const [rows] = await pool.query(
    `${SERVICE_SELECT} WHERE s.slug = ? LIMIT 1`,
    [slug],
  );
  const hydrated = await hydrateServices(rows);
  return hydrated[0] ?? null;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function normalizeServiceSlug(name, gender) {
  const base = slugify(name) || "service";
  const suffix = slugify(gender) || "unisex";
  return `${base}-${suffix}`.slice(0, 160);
}

export async function createService(data) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO services
        (slug, category_id, sub_category_id, name, audience, description, pricing_type, price, price_range, duration, image, image_url, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        data.slug,
        data.category_id,
        data.sub_category_id ?? null,
        data.name,
        data.audience ?? "Unisex",
        data.description ?? null,
        data.pricing_type ?? "fixed",
        data.price ?? null,
        data.price_range ?? null,
        data.duration ?? null,
        data.image ?? null,
        data.image_url ?? null,
        Boolean(data.is_active),
      ],
    );

    const serviceId = result.insertId;
    await writeVariants(connection, serviceId, data.variants);
    await writeBranches(connection, serviceId, data.branch_ids);

    await connection.commit();
    return serviceId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateService(id, data) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const fields = [];
    const values = [];

    if (data.name !== undefined) {
      fields.push("name = ?");
      values.push(data.name);
    }
    if (data.category_id !== undefined) {
      fields.push("category_id = ?");
      values.push(data.category_id);
    }
    if (data.sub_category_id !== undefined) {
      fields.push("sub_category_id = ?");
      values.push(data.sub_category_id);
    }
    if (data.audience !== undefined) {
      fields.push("audience = ?");
      values.push(data.audience);
    }
    if (data.description !== undefined) {
      fields.push("description = ?");
      values.push(data.description);
    }
    if (data.pricing_type !== undefined) {
      fields.push("pricing_type = ?");
      values.push(data.pricing_type);
    }
    if (data.price !== undefined) {
      fields.push("price = ?");
      values.push(data.price);
    }
    if (data.price_range !== undefined) {
      fields.push("price_range = ?");
      values.push(data.price_range);
    }
    if (data.duration !== undefined) {
      fields.push("duration = ?");
      values.push(data.duration);
    }
    if (data.image_url !== undefined) {
      fields.push("image_url = ?");
      values.push(data.image_url);
    }
    if (data.image !== undefined) {
      fields.push("image = ?");
      values.push(data.image);
    }
    if (data.is_active !== undefined) {
      fields.push("is_active = ?");
      values.push(Boolean(data.is_active));
    }

    if (fields.length > 0) {
      values.push(id);
      await connection.query(
        `UPDATE services SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );
    }

    if (data.variants !== undefined) {
      await connection.query(
        `DELETE FROM service_variants WHERE service_id = ?`,
        [id],
      );
      await writeVariants(connection, id, data.variants);
    }
    if (data.branch_ids !== undefined) {
      await connection.query(
        `DELETE FROM service_branches WHERE service_id = ?`,
        [id],
      );
      await writeBranches(connection, id, data.branch_ids);
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteService(id) {
  const [result] = await pool.query(`DELETE FROM services WHERE id = ?`, [id]);
  return result.affectedRows > 0;
}

export async function updateServiceStatus(id, isActive) {
  await pool.query(`UPDATE services SET is_active = ? WHERE id = ?`, [
    Boolean(isActive),
    id,
  ]);
}

// Helpers shared by create/update — run inside the caller's transaction.
async function writeVariants(connection, serviceId, variants) {
  const list = Array.isArray(variants) ? variants : [];
  for (const [index, variant] of list.entries()) {
    const label = String(variant?.label ?? "").trim();
    if (!label) continue;
    await connection.query(
      `INSERT INTO service_variants (service_id, label, price, duration, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [
        serviceId,
        label,
        Number(variant.price) || 0,
        variant.duration ?? null,
        index,
      ],
    );
  }
}

async function writeBranches(connection, serviceId, branchIds) {
  const list = Array.isArray(branchIds) ? branchIds : [];
  for (const branchId of list) {
    await connection.query(
      `INSERT INTO service_branches (service_id, branch_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [serviceId, branchId],
    );
  }
}
