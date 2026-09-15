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
      await replaceSubCategories(category.id, body.subCategories);
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
    const moved = await moveCategory(category.id, req.body.direction);
    return res.status(200).json({ success: true, moved });
  });
}

async function findBySlug(slug) {
  const row = await findCategoryBySlug(slug);
  if (!row) return null;
  return findCategoryById(row.id);
}
