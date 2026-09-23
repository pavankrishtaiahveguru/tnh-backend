// ==================================================
// Category controller — request/response handling for /api/categories
// ==================================================
import {
  findCategories,
  findCategoryById,
  findCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
  replaceSubCategories,
  normalizeCategorySlug,
  moveCategory,
  reorderSubCategories,
} from "../models/Category.js";

async function handle(res, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error("Category controller error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
}

export async function getCategories(req, res) {
  return handle(res, async () => {
    const categories = await findCategories();
    return res.status(200).json({ success: true, data: { categories } });
  });
}

export async function getCategory(req, res) {
  return handle(res, async () => {
    const { id } = req.params;

    const category = Number.isInteger(Number(id))
      ? await findCategoryById(Number(id))
      : await findBySlug(id);

    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }

    return res.status(200).json({ success: true, data: { category } });
  });
}

export async function createNewCategory(req, res) {
  return handle(res, async () => {
    const body = req.body ?? {};

    if (!body.name || !String(body.name).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Category name is required" });
    }

    const name = String(body.name).trim();

    let slug = body.slug
      ? normalizeCategorySlug(body.slug)
      : normalizeCategorySlug(name);
    if (await findCategoryBySlug(slug)) {
      return res.status(409).json({
        success: false,
        message: "A category with this name already exists",
      });
    }

    const categoryId = await createCategory({
      slug,
      name,
      description: body.description ?? null,
      icon: body.icon ?? "sparkles",
      image: body.image ?? body.imageUrl ?? null,
      image_url: body.imageUrl ?? null,
      is_active: body.isActive !== false,
    });

    if (Array.isArray(body.subCategories) && body.subCategories.length > 0) {
      await replaceSubCategories(categoryId, body.subCategories);
    }

    const category = await findCategoryById(categoryId);
    return res
      .status(201)
      .json({ success: true, message: "Category created", data: { category } });
  });
}

export async function updateExistingCategory(req, res) {
  return handle(res, async () => {
    const { id } = req.params;
    const body = req.body ?? {};

    const category = Number.isInteger(Number(id))
      ? await findCategoryById(Number(id))
      : await findBySlug(id);

    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }

    await updateCategory(category.id, {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      description: body.description,
      icon: body.icon,
      image: body.image !== undefined ? body.image : body.imageUrl,
      image_url: body.imageUrl,
      is_active:
        body.isActive !== undefined ? body.isActive !== false : undefined,
    });

    if (Array.isArray(body.subCategories)) {
      try {
        await replaceSubCategories(category.id, body.subCategories);
      } catch (error) {
        // A sub-category still referenced by services cannot be removed —
        // surface a real 409 instead of a generic 500.
        if (String(error?.message ?? "").startsWith("SUBCATEGORY_IN_USE:")) {
          const [, name, count] = String(error.message).split(":");
          return res.status(409).json({
            success: false,
            message: `Cannot remove "${name}" — ${count} service${count === "1" ? "" : "s"} still belong${count === "1" ? "s" : ""} to it. Reassign those services first.`,
          });
        }
        throw error;
      }
    }

    const updated = await findCategoryById(category.id);
    return res.status(200).json({
      success: true,
      message: "Category updated",
      data: { category: updated },
    });
  });
}

export async function removeCategory(req, res) {
  return handle(res, async () => {
    const { id } = req.params;

    const category = Number.isInteger(Number(id))
      ? await findCategoryById(Number(id))
      : await findBySlug(id);

    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }

    // Guard: refuse to delete a category that still owns services or
    // sub-categories with services. Deleting would otherwise cascade sub
    // rows (ON DELETE CASCADE) and set every service's sub_category_id to
    // NULL — destroying mapping data silently.
    const serviceCount = Number(category.service_count ?? 0);
    if (serviceCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete "${category.name}" — ${serviceCount} service${serviceCount === 1 ? "" : "s"} still belong${serviceCount === 1 ? "s" : ""} to it. Move or delete those services first.`,
      });
    }

    await deleteCategory(category.id);
    return res.status(200).json({ success: true, message: "Category deleted" });
  });
}

export async function reorderCategory(req, res) {
  return handle(res, async () => {
    const category = Number.isInteger(Number(req.params.id))
      ? await findCategoryById(Number(req.params.id))
      : await findBySlug(req.params.id);
    if (!category)
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    if (!["up", "down"].includes(req.body?.direction)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid category direction" });
    }
    const move = await moveCategory(category.id, req.body.direction);
    // Edge moves (already first/last) are validation failures, not silent
    // successes — the database is untouched, so reporting "order updated"
    // would be a false success and the admin UI would show an order that
    // isn't real.
    if (move.status === "top" || move.status === "bottom") {
      const message =
        move.status === "top"
          ? "Category is already first — it cannot move up further"
          : "Category is already last — it cannot move down further";
      return res.status(400).json({ success: false, message });
    }
    if (move.status === "not-found") {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }
    // Return the full updated category (fresh from the DB) so the admin UI
    // can refresh state from the authoritative server response.
    const updated = await findCategoryById(category.id);
    return res.status(200).json({
      success: true,
      message: "Category order updated",
      moved: true,
      rowsUpdated: move.rowsUpdated,
      data: { category: updated },
    });
  });
}

// PUT /api/categories/:categoryId/subcategories/reorder
export async function reorderCategorySubCategories(req, res) {
  return handle(res, async () => {
    const { categoryId } = req.params;

    const category = Number.isInteger(Number(categoryId))
      ? await findCategoryById(Number(categoryId))
      : await findBySlug(categoryId);
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }

    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "items must be a non-empty array of { id, displayOrder }",
      });
    }

    const result = await reorderSubCategories(category.id, items);

    if (result.status === "invalid-items") {
      return res.status(400).json({
        success: false,
        message:
          "Each item needs a valid sub-category id and a non-negative displayOrder",
      });
    }
    if (result.status === "duplicate-ids") {
      return res.status(400).json({
        success: false,
        message: "items contains duplicate sub-category ids",
      });
    }
    if (result.status === "not-found") {
      return res.status(404).json({
        success: false,
        message: "This category has no sub-categories to reorder",
      });
    }
    if (result.status === "set-mismatch") {
      return res.status(400).json({
        success: false,
        message:
          "items must include every sub-category currently in this category, and only sub-categories that belong to it",
      });
    }

    // Fresh from the DB so the admin UI can trust the server's confirmed
    // order rather than assuming its own optimistic update landed.
    const updated = await findCategoryById(category.id);
    return res.status(200).json({
      success: true,
      message: "Sub-category order updated",
      data: { category: updated, subCategories: updated.subcategories },
    });
  });
}

async function findBySlug(slug) {
  const row = await findCategoryBySlug(slug);
  if (!row) return null;
  return findCategoryById(row.id);
}
