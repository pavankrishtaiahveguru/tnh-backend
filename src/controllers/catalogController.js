// ==================================================
// Catalog controller — request/response handling for /api/catalog
// ==================================================
import {
  exportCatalog,
  importCatalog,
  CatalogValidationError,
} from "../models/Catalog.js";

// Wraps controller bodies so unexpected errors never leak SQL or stack traces
// (same pattern as the other controllers).
async function handle(res, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error("Catalog controller error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
}

// GET /api/catalog/export
// Responds with the actual database catalog as a downloadable JSON file.
export async function exportCatalogJson(req, res) {
  return handle(res, async () => {
    const catalog = await exportCatalog();

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tnh-salon-catalog-${stamp}.json"`,
    );
    return res.status(200).send(JSON.stringify(catalog, null, 2));
  });
}

// POST /api/catalog/import
// Accepts the catalog payload in two forms:
//   1. multipart/form-data with a previously exported .json file, or
//   2. a JSON request body (used by the Admin Excel import flow, which parses
//      the .xlsx client-side into the exact same JSON structure).
// In both cases the database keeps receiving the existing JSON structure —
// Excel itself never reaches the backend. Rows with problems are skipped
// and reported.
export async function importCatalogFile(req, res) {
  return handle(res, async () => {
    let payload = null;

    if (req.file) {
      // Legacy path: multipart upload of a previously exported .json file.
      try {
        payload = JSON.parse(req.file.buffer.toString("utf8"));
      } catch {
        return res.status(400).json({
          success: false,
          message: "The file is not valid JSON. Export a catalog file first and upload that.",
        });
      }
    } else if (
      req.body &&
      typeof req.body === "object" &&
      Object.keys(req.body).length > 0
    ) {
      // Excel import path: the .xlsx was parsed to this JSON client-side.
      payload = req.body;
    }

    if (!payload) {
      return res
        .status(400)
        .json({ success: false, message: "Please choose a file to import." });
    }

    try {
      const result = await importCatalog(payload);

      const summary = `${result.services} service${result.services === 1 ? "" : "s"}, ${result.categories} categor${result.categories === 1 ? "y" : "ies"} and ${result.subCategories} sub-categor${result.subCategories === 1 ? "y" : "ies"} imported.`;
      return res.status(200).json({
        success: true,
        message:
          result.issues.length > 0
            ? `Import completed with ${result.issues.length} skipped row${result.issues.length === 1 ? "" : "s"}. ${summary}`
            : `Import completed successfully. ${summary}`,
        data: result,
      });
    } catch (error) {
      if (error instanceof CatalogValidationError) {
        return res
          .status(400)
          .json({ success: false, message: error.message });
      }
      throw error;
    }
  });
}
