// ==================================================
// Service controller — request/response handling for /api/services
// ==================================================
import {
  findServices,
  findServiceById,
  findServiceBySlug,
  createService,
  updateService,
  deleteService,
  updateServiceStatus,
  normalizeServiceSlug,
} from "../models/Service.js";
import {
  findCategoryBySlug,
  findSubCategoriesByCategoryId,
} from "../models/Category.js";
import { findBranches } from "../models/Branch.js";

// Wraps controller bodies so unexpected errors never leak SQL or stack traces.
async function handle(res, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error("Service controller error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
}

export async function getServices(req, res) {
  return handle(res, async () => {
    const { search, category, subCategory, branch, audience, status } =
      req.query;

    const services = await findServices({
      search,
      categorySlug: category,
      subCategorySlug: subCategory,
      branchSlug: branch,
      audience,
      status,
    });

    return res.status(200).json({ success: true, data: { services } });
  });
}

export async function getService(req, res) {
  return handle(res, async () => {
    const { id } = req.params;

    const service = Number.isInteger(Number(id))
      ? await findServiceById(Number(id))
      : await findServiceBySlug(id);

    if (!service) {
      return res
        .status(404)
        .json({ success: false, message: "Service not found" });
    }

    return res.status(200).json({ success: true, data: { service } });
  });
}

export async function createNewService(req, res) {
  return handle(res, async () => {
    const body = req.body ?? {};

    if (!body.name || !String(body.name).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Service name is required" });
    }
    if (!body.categoryId) {
      return res
        .status(400)
        .json({ success: false, message: "Category is required" });
    }

    const category = Number.isInteger(Number(body.categoryId))
      ? { id: Number(body.categoryId) }
      : await findCategoryBySlug(String(body.categoryId));

    if (!category) {
      return res
        .status(400)
        .json({ success: false, message: "Category not found" });
    }

    const branchIds = await resolveBranchIds(
      body.branchIds ?? body.branch_ids ?? [],
    );
    if (branchIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "At least one branch is required" });
    }

    const subCategoryId = await resolveSubCategoryId(
      category.id,
      body.subCategoryId ?? body.sub_category_id,
    );

    const slug = normalizeServiceSlug(body.name, body.audience);
    const existing = await findServiceBySlug(slug);
    const finalSlug = existing ? `${slug}-${Date.now()}` : slug;

    const serviceId = await createService({
      slug: finalSlug,
      category_id: category.id,
      sub_category_id: subCategoryId,
      name: String(body.name).trim(),
      audience: body.audience ?? "Unisex",
      description: body.description ?? null,
      pricing_type: body.pricingType ?? "fixed",
      price:
        body.pricingType === "fixed" || body.pricingType === "from"
          ? Number(body.price) || 0
          : null,
      price_range:
        body.pricingType === "fixed" || body.pricingType === "from"
          ? (body.priceRange ?? null)
          : (body.priceRange ?? null),
      duration: body.duration ?? null,
      image: body.image ?? body.imageUrl ?? null,
      image_url: body.imageUrl ?? null,
      is_active: body.isActive !== false,
      variants: body.variants ?? [],
      branch_ids: branchIds,
    });

    const service = await findServiceById(serviceId);
    return res
      .status(201)
      .json({ success: true, message: "Service created", data: { service } });
  });
}

export async function updateExistingService(req, res) {
  return handle(res, async () => {
    const { id } = req.params;
    const body = req.body ?? {};

    const service = Number.isInteger(Number(id))
      ? await findServiceById(Number(id))
      : await findServiceBySlug(id);

    if (!service) {
      return res
        .status(404)
        .json({ success: false, message: "Service not found" });
    }

    let categoryId;
    if (body.categoryId !== undefined) {
      const category = Number.isInteger(Number(body.categoryId))
        ? { id: Number(body.categoryId) }
        : await findCategoryBySlug(String(body.categoryId));
      if (!category) {
        return res
          .status(400)
          .json({ success: false, message: "Category not found" });
      }
      categoryId = category.id;
    }

    let branchIds;
    if (body.branchIds !== undefined || body.branch_ids !== undefined) {
      branchIds = await resolveBranchIds(
        body.branchIds ?? body.branch_ids ?? [],
      );
      if (branchIds.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "At least one branch is required" });
      }
    }

    const sub_category_id =
      body.subCategoryId !== undefined || body.sub_category_id !== undefined
        ? await resolveSubCategoryId(
            categoryId ?? service.category_id,
            body.subCategoryId ?? body.sub_category_id,
          )
        : undefined;

    await updateService(service.id, {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      category_id: categoryId,
      sub_category_id,
      audience: body.audience,
      description: body.description,
      pricing_type: body.pricingType,
      price:
        body.price !== undefined
          ? Number(body.price) || 0
          : body.pricingType !== undefined &&
              body.pricingType !== "fixed" &&
              body.pricingType !== "from"
            ? null
            : undefined,
      price_range:
        body.priceRange !== undefined
          ? body.priceRange
          : body.pricingType !== undefined &&
              body.pricingType !== "fixed" &&
              body.pricingType !== "from"
            ? (body.priceRange ?? null)
            : undefined,
      duration: body.duration,
      image: body.image !== undefined ? body.image : body.imageUrl,
      image_url: body.imageUrl,
      is_active:
        body.isActive !== undefined ? body.isActive !== false : undefined,
      variants: body.variants,
      branch_ids: branchIds,
    });

    const updated = await findServiceById(service.id);
    return res.status(200).json({
      success: true,
      message: "Service updated",
      data: { service: updated },
    });
  });
}

export async function updateExistingServiceStatus(req, res) {
  return handle(res, async () => {
    const { id } = req.params;
    const { status } = req.body ?? {};

    if (status !== "Active" && status !== "Inactive") {
      return res
        .status(400)
        .json({ success: false, message: "Status must be Active or Inactive" });
    }

    const service = Number.isInteger(Number(id))
      ? await findServiceById(Number(id))
      : await findServiceBySlug(id);

    if (!service) {
      return res
        .status(404)
        .json({ success: false, message: "Service not found" });
    }

    await updateServiceStatus(service.id, status === "Active");

    const updated = await findServiceById(service.id);
    return res.status(200).json({
      success: true,
      message: "Service status updated",
      data: { service: updated },
    });
  });
}

export async function removeService(req, res) {
  return handle(res, async () => {
    const { id } = req.params;

    const service = Number.isInteger(Number(id))
      ? await findServiceById(Number(id))
      : await findServiceBySlug(id);

    if (!service) {
      return res
        .status(404)
        .json({ success: false, message: "Service not found" });
    }

    await deleteService(service.id);
    return res.status(200).json({ success: true, message: "Service deleted" });
  });
}

// Resolves branch identifiers (id, or slug like "sarjapur-road") to DB ids.
async function resolveBranchIds(branchIds) {
  const branches = await findBranches();
  const resolved = [];

  for (const value of branchIds) {
    const asNumber = Number(value);
    if (Number.isInteger(asNumber)) {
      resolved.push(asNumber);
      continue;
    }
    const match = branches.find(
      (branch) =>
        branch.slug === value ||
        branch.name.toLowerCase() === String(value).toLowerCase(),
    );
    if (match) resolved.push(match.id);
  }

  return resolved;
}

// Resolves a sub-category (id, slug, or name) within a category. Empty string
// or null clears the sub-category.
async function resolveSubCategoryId(categoryId, value) {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "none") return null;

  const asNumber = Number(value);
  if (Number.isInteger(asNumber)) return asNumber;

  const subCategories = await findSubCategoriesByCategoryId(categoryId);
  const match = subCategories.find(
    (sub) =>
      sub.slug === value ||
      sub.name.toLowerCase() === String(value).toLowerCase(),
  );
  return match ? match.id : null;
}
