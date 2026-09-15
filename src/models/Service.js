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

// GET /api/services — supports search/category/subCategory/branch/audience/status filters.
export async function findServices(filters = {}) {
  const conditions = [];
  const values = [];

  if (filters.search) {
    conditions.push(`(s.name LIKE ? OR c.name LIKE ? OR sc.name LIKE ?)`);
    const term = `%${filters.search}%`;
    values.push(term, term, term);
  }
  if (filters.categorySlug) {
    conditions.push(`c.slug = ?`);
    values.push(filters.categorySlug);
  }
  if (filters.subCategorySlug) {
    conditions.push(`sc.slug = ?`);
    values.push(filters.subCategorySlug);
  }
  if (filters.audience) {
    conditions.push(`s.audience = ?`);
    values.push(filters.audience);
  }
  if (filters.status === "Active") {
    conditions.push(`s.is_active = TRUE`);
  } else if (filters.status === "Inactive") {
    conditions.push(`s.is_active = FALSE`);
  }
  if (filters.branchSlug) {
    if (filters.branchSlug === "both") {
      conditions.push(
        `NOT EXISTS (
           SELECT 1 FROM service_branches sb_ex
           WHERE sb_ex.service_id = s.id
             AND sb_ex.branch_id NOT IN (SELECT id FROM branches WHERE slug IN ('indiranagar', 'sarjapur-road'))
         ) AND (
           SELECT COUNT(*) FROM service_branches sb_cnt
           WHERE sb_cnt.service_id = s.id
         ) = 2`,
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

  const whereClause =
    conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const [rows] = await pool.query(
    `${SERVICE_SELECT}${whereClause} ORDER BY s.display_order, s.name`,
    values,
  );
  return hydrateServices(rows);
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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.is_active ? 1 : 0,
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
      values.push(data.is_active ? 1 : 0);
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
    isActive ? 1 : 0,
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
      `INSERT IGNORE INTO service_branches (service_id, branch_id) VALUES (?, ?)`,
      [serviceId, branchId],
    );
  }
}
