// ==================================================
// Category model — raw SQL queries for categories + sub-categories
// ==================================================
import pool from "../config/database.js";

export async function findCategories() {
  const [categories] = await pool.query(
    `SELECT c.id, c.slug, c.name, c.description, c.icon, c.image, c.image_url,
            c.display_order, c.is_active, c.created_at, c.updated_at,
            COUNT(DISTINCT s.id) AS service_count
     FROM categories c
     LEFT JOIN sub_categories sc ON sc.category_id = c.id
     LEFT JOIN services s
       ON s.category_id = c.id OR s.sub_category_id = sc.id
     GROUP BY c.id, c.slug, c.name, c.description, c.icon, c.image,
              c.image_url, c.display_order, c.is_active, c.created_at, c.updated_at
     ORDER BY display_order, id`,
  );

  if (categories.length === 0) return [];

  const [subCategories] = await pool.query(
    `SELECT sc.id, sc.category_id, sc.slug, sc.name,
            (SELECT COUNT(*) FROM services s WHERE s.sub_category_id = sc.id) AS service_count
     FROM sub_categories sc
     ORDER BY sc.name`,
  );

  const subsByCategory = new Map();
  for (const sub of subCategories) {
    if (!subsByCategory.has(sub.category_id)) {
      subsByCategory.set(sub.category_id, []);
    }
    subsByCategory.get(sub.category_id).push({
      id: sub.id,
      slug: sub.slug,
      name: sub.name,
      service_count: Number(sub.service_count),
    });
  }

  return categories.map((category) => ({
    ...category,
    subcategories: subsByCategory.get(category.id) ?? [],
    service_count: Number(category.service_count),
  }));
}

export async function findCategoryById(id) {
  const [rows] = await pool.query(
    `SELECT c.id, c.slug, c.name, c.description, c.icon, c.image, c.image_url,
            c.display_order, c.is_active, c.created_at, c.updated_at,
            COUNT(DISTINCT s.id) AS service_count
     FROM categories c
     LEFT JOIN sub_categories sc ON sc.category_id = c.id
     LEFT JOIN services s
       ON s.category_id = c.id OR s.sub_category_id = sc.id
     WHERE c.id = ?
     GROUP BY c.id, c.slug, c.name, c.description, c.icon, c.image,
              c.image_url, c.display_order, c.is_active, c.created_at, c.updated_at
     LIMIT 1`,
    [id],
  );

  const category = rows[0];
  if (!category) return null;

  const [subCategories] = await pool.query(
    `SELECT id, slug, name,
            (SELECT COUNT(*) FROM services s WHERE s.sub_category_id = sc.id) AS service_count
     FROM sub_categories sc
     WHERE sc.category_id = ?
     ORDER BY sc.name`,
    [id],
  );

  return {
    ...category,
    subcategories: subCategories.map((sub) => ({
      id: sub.id,
      slug: sub.slug,
      name: sub.name,
      service_count: Number(sub.service_count),
    })),
    service_count: Number(category.service_count),
  };
}

export async function findCategoryBySlug(slug) {
  const [rows] = await pool.query(
    `SELECT id FROM categories WHERE slug = ? LIMIT 1`,
    [slug],
  );
  return rows[0] ?? null;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function normalizeCategorySlug(name, fallback = "category") {
  return slugify(name) || fallback;
}

export async function createCategory(data) {
  const [[nextOrder]] = await pool.query(
    "SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order FROM categories",
  );
  const [result] = await pool.query(
    `INSERT INTO categories (slug, name, description, icon, image, image_url, display_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.slug,
      data.name,
      data.description ?? null,
      data.icon ?? "sparkles",
      data.image ?? null,
      data.image_url ?? null,
      nextOrder.next_order,
      data.is_active ? 1 : 0,
    ],
  );
  return result.insertId;
}

export async function moveCategory(id, direction) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, display_order FROM categories ORDER BY display_order, id FOR UPDATE",
    );
    const index = rows.findIndex((row) => row.id === id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= rows.length) {
      await connection.rollback();
      return false;
    }
    const current = rows[index];
    const target = rows[targetIndex];
    await connection.query(
      "UPDATE categories SET display_order = ? WHERE id = ?",
      [target.display_order, current.id],
    );
    await connection.query(
      "UPDATE categories SET display_order = ? WHERE id = ?",
      [current.display_order, target.id],
    );
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateCategory(id, data) {
  const fields = [];
  const values = [];

  if (data.name !== undefined) {
    fields.push("name = ?");
    values.push(data.name);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.icon !== undefined) {
    fields.push("icon = ?");
    values.push(data.icon);
  }
  if (data.image !== undefined) {
    fields.push("image = ?");
    values.push(data.image);
  }
  if (data.image_url !== undefined) {
    fields.push("image_url = ?");
    values.push(data.image_url);
  }
  if (data.is_active !== undefined) {
    fields.push("is_active = ?");
    values.push(data.is_active ? 1 : 0);
  }

  if (fields.length === 0) return;

  values.push(id);
  await pool.query(
    `UPDATE categories SET ${fields.join(", ")} WHERE id = ?`,
    values,
  );
}

export async function deleteCategory(id) {
  const [result] = await pool.query(`DELETE FROM categories WHERE id = ?`, [
    id,
  ]);
  return result.affectedRows > 0;
}

// ---- Sub-categories ----

export async function replaceSubCategories(categoryId, names) {
  await pool.query(`DELETE FROM sub_categories WHERE category_id = ?`, [
    categoryId,
  ]);

  const seen = new Set();
  for (const name of names) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) continue;
    const slug = slugify(trimmed);
    if (seen.has(slug)) continue;
    seen.add(slug);

    await pool.query(
      `INSERT INTO sub_categories (category_id, slug, name) VALUES (?, ?, ?)`,
      [categoryId, slug, trimmed],
    );
  }
}

export async function findSubCategoriesByCategoryId(categoryId) {
  const [rows] = await pool.query(
    `SELECT id, slug, name FROM sub_categories WHERE category_id = ? ORDER BY name`,
    [categoryId],
  );
  return rows;
}
