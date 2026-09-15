// ==================================================
// Branch model — raw SQL queries against the `branches` table
// ==================================================
import pool from "../config/database.js";

const BRANCH_SELECT = `
    SELECT id, slug, name, phone, email, address, map_url, map_embed_url,
      title, subtitle, hours, about_title, is_active, created_at, updated_at
  FROM branches
`;

export async function findBranches() {
  const [rows] = await pool.query(`${BRANCH_SELECT} ORDER BY id`);
  return rows;
}

export async function findBranchById(id) {
  const [rows] = await pool.query(`${BRANCH_SELECT} WHERE id = ? LIMIT 1`, [
    id,
  ]);
  return rows[0] ?? null;
}

export async function findBranchBySlug(slug) {
  const [rows] = await pool.query(`${BRANCH_SELECT} WHERE slug = ? LIMIT 1`, [
    slug,
  ]);
  return rows[0] ?? null;
}

export async function updateBranch(id, data) {
  const fields = [];
  const values = [];

  if (data.name !== undefined) {
    fields.push("name = ?");
    values.push(data.name);
  }
  if (data.phone !== undefined) {
    fields.push("phone = ?");
    values.push(data.phone);
  }
  if (data.email !== undefined) {
    fields.push("email = ?");
    values.push(data.email);
  }
  if (data.address !== undefined) {
    fields.push("address = ?");
    values.push(data.address);
  }
  if (data.map_url !== undefined) {
    fields.push("map_url = ?");
    values.push(data.map_url);
  }
  if (data.hours !== undefined) {
    fields.push("hours = ?");
    values.push(data.hours == null ? null : JSON.stringify(data.hours));
  }
  if (data.is_active !== undefined) {
    fields.push("is_active = ?");
    values.push(data.is_active ? 1 : 0);
  }

  if (fields.length === 0) return findBranchById(id);

  values.push(id);
  await pool.query(
    `UPDATE branches SET ${fields.join(", ")} WHERE id = ?`,
    values,
  );
  return findBranchById(id);
}
