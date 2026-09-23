// ==================================================
// Service controller — request/response handling for /api/services
// ==================================================
import {
  findServices,
  findServicesPage,
  countActiveServices,
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
import { runWithQueryContext } from "../config/database.js";
import { logApiTiming } from "../utils/perfLog.js";

// Pagination defaults (Phase 5) — sensible maximum so no client can request
// thousands of rows at once.
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 50;

// Whitelist of sort keys the frontend may pass (Phase 8). Anything else falls
// back to the default catalog order inside the model layer.
const ALLOWED_SORTS = new Set([
  "menu",
  "nameAsc",
  "nameDesc",
  "priceAsc",
  "priceDesc",
]);

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
  const startedAt = performance.now();
  return handle(res, async () => {
    const {
      search,
      category,
      subCategory,
      branch,
      audience,
      status,
      page,
      limit,
      sort,
      priceMin,
      priceMax,
    } = req.query;

    // New paginated path (page/limit/sort/price params present) — used by the
    // public Services page. The legacy shape (no page param) keeps returning
    // the full filtered list, so existing consumers are unaffected.
    const usePagination = page !== undefined || limit !== undefined;

    const filters = {
      search: search?.trim() || undefined,
      categorySlug: category,
      // Accepted as slug OR display name (public page chips use names; admin
      // callers use slugs) — the model matches either.
      subCategorySlug: subCategory,
      subCategoryName: subCategory,
      branchSlug: branch,
      audience,
      status,
      sort: ALLOWED_SORTS.has(sort) ? sort : undefined,
      priceMin: priceMin != null && priceMin !== "" && Number.isFinite(Number(priceMin))
        ? Number(priceMin)
        : undefined,
      priceMax: priceMax != null && priceMax !== "" && Number.isFinite(Number(priceMax))
        ? Number(priceMax)
        : undefined,
      limit: limit != null && limit !== "" ? Number(limit) : DEFAULT_LIMIT,
      maxLimit: MAX_LIMIT,
      page: page != null && page !== "" ? Number(page) : 1,
      includeFacets: usePagination,
    };

    const { result, stats } = await runWithQueryContext(() =>
      usePagination ? findServicesPage(filters) : findServices(filters),
    );

    const services = Array.isArray(result) ? result : result.services;
    const pagination = Array.isArray(result) ? undefined : result.pagination;
    const subCategories =
      Array.isArray(result) || !usePagination ? undefined : result.subCategories;

    logApiTiming(
      "Services API",
      {
        startedAt,
        method: req.method,
        url: req.originalUrl,
        rowCount: services.length,
      },
      stats,
    );

    return res.status(200).json(
      pagination
        ? { success: true, data: { services }, subCategories, pagination }
        : { success: true, data: { services } },
    );
  });
}

// GET /api/services/count — unfiltered total of active services. Powers the
// Services page hero stat, which must stay constant regardless of any
// category/subcategory/branch/gender/search filters. Returns ONE integer —
// no rows are fetched.
export async function getServicesCount(req, res) {
  const startedAt = performance.now();
  return handle(res, async () => {
    const { result: count, stats } = await runWithQueryContext(() =>
      countActiveServices(),
    );

    logApiTiming(
      "Services Count API",
      {
        startedAt,
        method: req.method,
        url: req.originalUrl,
        rowCount: 1,
      },
      stats,
    );

    return res.status(200).json({ success: true, count });
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

    let subCategoryId;
    try {
      subCategoryId = await resolveSubCategoryId(
        category.id,
        body.subCategoryId ?? body.sub_category_id,
      );
    } catch (error) {
      if (error?.code === "SUBCATEGORY_MISMATCH") {
        return res.status(400).json({ success: false, message: error.message });
      }
      throw error;
    }

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

    let sub_category_id;
    if (
      body.subCategoryId !== undefined || body.sub_category_id !== undefined
    ) {
      try {
        sub_category_id = await resolveSubCategoryId(
          categoryId ?? service.category_id,
          body.subCategoryId ?? body.sub_category_id,
        );
      } catch (error) {
        if (error?.code === "SUBCATEGORY_MISMATCH") {
          return res.status(400).json({ success: false, message: error.message });
        }
        throw error;
      }
    }

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
// Resolve an incoming sub-category reference (numeric id, slug, or name)
// into a sub_categories.id that is GUARANTEED to belong to `categoryId`.
//
// HISTORICAL BUG (fixed): the numeric branch returned the raw value without
// any parent-category check, so a stale/mismatched subCategoryId from the
// frontend could silently map a service to a sub-category owned by a
// DIFFERENT category (the schema's composite FKs do not enforce
// sub_categories.category_id = services.category_id).
// Returns:
//   undefined → caller sent nothing (no change)
//   null      → caller explicitly cleared it (null / "" / "none")
//   number    → verified sub_categories.id owned by categoryId
//   throws SUBCATEGORY_MISMATCH → value present but not in this category
async function resolveSubCategoryId(categoryId, value) {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "none") return null;

  const subCategories = await findSubCategoriesByCategoryId(categoryId);
  const asNumber = Number(value);
  const match = Number.isInteger(asNumber)
    ? subCategories.find((sub) => Number(sub.id) === asNumber)
    : subCategories.find(
        (sub) =>
          sub.slug === value ||
          sub.name.toLowerCase() === String(value).toLowerCase(),
      );
  if (!match) {
    const error = new Error(
      `Sub-category "${value}" does not belong to the selected category`,
    );
    error.code = "SUBCATEGORY_MISMATCH";
    throw error;
  }
  return match.id;
}
