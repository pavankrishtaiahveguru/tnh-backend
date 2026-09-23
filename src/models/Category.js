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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      data.slug,
      data.name,
      data.description ?? null,
      data.icon ?? "sparkles",
      data.image ?? null,
      data.image_url ?? null,
      nextOrder.next_order,
      Boolean(data.is_active),
    ],
  );
  return result.insertId;
}

// Move a category one position up/down in the admin ordering.
//
// Resequence strategy — NOT a naive value swap. Seeded rows can share the
// same display_order (the seeder historically left it at the schema default
// of 0), so swapping the two raw values can be a silent no-op (0 ↔ 0) that
// still commits and reports success. Instead, inside one transaction:
//   1. lock every row (FOR UPDATE) in the canonical (display_order, id) order
//   2. swap the two adjacent entries in that ordered array
//   3. rewrite sequential display_order values (1..n) for every row whose
//      position actually changed
// The first reorder heals any existing ties; afterwards the column stays
// dense (1..n) so subsequent moves remain correct.
// Returns { status, rowsUpdated } where status is one of
// "moved" | "top" | "bottom" | "not-found" — the controller maps the edge
// cases to honest 400s instead of a false "order updated" success.
export async function moveCategory(id, direction) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, display_order FROM categories ORDER BY display_order, id FOR UPDATE",
    );
    const index = rows.findIndex((row) => row.id === id);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0) {
      await connection.rollback();
      return { status: "not-found", rowsUpdated: 0 };
    }
    if (targetIndex < 0) {
      await connection.rollback();
      return { status: "top", rowsUpdated: 0 };
    }
    if (targetIndex >= rows.length) {
      await connection.rollback();
      return { status: "bottom", rowsUpdated: 0 };
    }

    // New ordering = the locked order with the two neighbours exchanged.
    const orderedIds = rows.map((row) => row.id);
    [orderedIds[index], orderedIds[targetIndex]] = [
      orderedIds[targetIndex],
      orderedIds[index],
    ];

    const previousOrders = new Map(
      rows.map((row) => [row.id, Number(row.display_order)]),
    );
    let rowsUpdated = 0;
    for (let position = 0; position < orderedIds.length; position += 1) {
      const rowId = orderedIds[position];
      const nextOrder = position + 1;
      if (previousOrders.get(rowId) === nextOrder) continue;
      await connection.query(
        "UPDATE categories SET display_order = ? WHERE id = ?",
        [nextOrder, rowId],
      );
      rowsUpdated += 1;
    }

    await connection.commit();
    return { status: "moved", rowsUpdated };
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
    values.push(Boolean(data.is_active));
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

// Diff-sync a category's sub-categories against the incoming list.
//
// HISTORICAL BUG (fixed): this used to DELETE every sub-category row of the
// category and re-INSERT the incoming names. Because services.sub_category_id
// is `ON DELETE SET NULL`, every admin category edit silently DETACHED all of
// that category's services from their sub-categories (and the re-inserted
// rows got new IDs, so they appeared in Admin as empty groups). The frontend
// always sends the sub-category list on every category save, so even a save
// that changed nothing destroyed the relationships.
//
// New behavior (diff-sync, matched by slug/numeric id — never by display
// name alone):
//   - incoming entries WITH a known id: rename in place (name update only,
//     slug stays a stable identifier)
//   - incoming entries WITHOUT a known id: INSERT (case-insensitive name
//     match against the category's existing subs first, so "men" vs "Men"
//     never duplicates)
//   - existing subs ABSENT from the incoming list: DELETE — but only when no
//     service still references them; otherwise the whole operation aborts
//     with a descriptive error (transaction rollback) instead of silently
//     orphaning services via ON DELETE SET NULL.
// Runs inside a transaction; returns { inserted, renamed, removed } counts.
// Accepts plain strings ("Men") or objects ({ id: "men" | 12, name: "Men" }).
export async function replaceSubCategories(categoryId, entries) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [existingRows] = await connection.query(
      `SELECT id, slug, name FROM sub_categories WHERE category_id = ?`,
      [categoryId],
    );
    const existing = existingRows.map((row) => ({
      id: Number(row.id),
      slug: row.slug,
      name: row.name,
    }));
    const bySlug = new Map(existing.map((sub) => [sub.slug, sub]));
    const byId = new Map(existing.map((sub) => [String(sub.id), sub]));
    const byLowerName = new Map(
      existing.map((sub) => [sub.name.toLowerCase(), sub]),
    );

    let inserted = 0;
    let renamed = 0;
    let removed = 0;
    const claimedSlugs = new Set();

    const normalizeEntry = (entry) => {
      if (typeof entry === "string") return { id: undefined, name: entry };
      if (entry && typeof entry === "object")
        return { id: entry.id ?? entry.slug, name: entry.name };
      return null;
    };

    const seen = new Set();
    for (const raw of entries ?? []) {
      const entry = normalizeEntry(raw);
      const name = String(entry?.name ?? "").trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue; // dedupe within the incoming list
      seen.add(lower);

      // Match by explicit id (slug or numeric), then by case-insensitive name.
      const matchById = entry.id != null
        ? bySlug.get(String(entry.id)) ?? byId.get(String(entry.id))
        : undefined;
      const match = matchById ?? byLowerName.get(lower);

      if (match) {
        claimedSlugs.add(match.slug);
        if (match.name !== name) {
          await connection.query(
            `UPDATE sub_categories SET name = ? WHERE id = ?`,
            [name, match.id],
          );
          renamed += 1;
        }
      } else {
        // New sub-category. Derive a slug; add a stable suffix if it collides
        // with a different name in the same category (same rule as the
        // catalog seeder).
        const base = slugify(name) || "sub-category";
        const collision = new Set([...claimedSlugs, ...bySlug.keys()]).has(base);
        const slug = collision ? `${base}-${slugify(String(entry.id ?? "")).slice(0, 40) || Date.now().toString(36)}` : base;
        await connection.query(
          `INSERT INTO sub_categories (category_id, slug, name) VALUES (?, ?, ?)`,
          [categoryId, slug, name],
        );
        claimedSlugs.add(slug);
        inserted += 1;
      }
    }

    // Removals: only subs the incoming list did not claim. Never orphan
    // services — block with a clear error if any sub still has services.
    const wanted = new Set((entries ?? []).map(normalizeEntry).filter(Boolean).map((e) => String(e.id ?? "").toLowerCase()).filter(Boolean));
    const keepByLowerName = new Set((entries ?? []).map(normalizeEntry).filter(Boolean).map((e) => String(e.name ?? "").trim().toLowerCase()).filter(Boolean));
    for (const sub of existing) {
      if (claimedSlugs.has(sub.slug)) continue;
      // The list is name+id based; a sub survives if it was claimed by id OR
      // an entry with the same (case-insensitive) name exists.
      if (wanted.has(sub.slug.toLowerCase()) || keepByLowerName.has(sub.name.toLowerCase()))
        continue;

      const [usageRows] = await connection.query(
        `SELECT COUNT(*) AS c FROM services WHERE sub_category_id = ?`,
        [sub.id],
      );
      const inUse = Number(usageRows[0]?.c ?? 0) > 0;
      if (inUse) {
        throw new Error(
          `SUBCATEGORY_IN_USE:${sub.name}:${usageRows[0].c}`,
        );
      }
      await connection.query(
        `DELETE FROM sub_categories WHERE id = ?`,
        [sub.id],
      );
      removed += 1;
    }

    await connection.commit();
    return { inserted, renamed, removed };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function findSubCategoriesByCategoryId(categoryId) {
  const [rows] = await pool.query(
    `SELECT id, slug, name FROM sub_categories WHERE category_id = ? ORDER BY name`,
    [categoryId],
  );
  return rows;
}
