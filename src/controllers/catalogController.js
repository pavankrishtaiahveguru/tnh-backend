// ==================================================
// Catalog controller — reference-format Excel export & import for /api/catalog
// ==================================================
import {
  exportServicesWorkbook,
  parseServicesWorkbook,
  applyServicesImport,
  CatalogImportError,
} from "../services/catalogExcelService.js";

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
// Streams the actual database catalogue as the reference-format .xlsx —
// exactly two sheets ("Services", "How to edit"), 17 service columns, no
// internal database fields.
export async function exportCatalogExcel(req, res) {
  return handle(res, async () => {
    const buffer = await exportServicesWorkbook();

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="the-nail-hue-services-${stamp}.xlsx"`,
    );
    return res.status(200).send(buffer);
  });
}

// POST /api/catalog/import
// Accepts the reference-format .xlsx (multipart field "file"). The whole file
// is parsed and validated BEFORE any database change; valid files are applied
// inside a single transaction. Existing services are matched and updated by
// Category + Service Name + Gender, so re-importing an export never creates
// duplicates.
export async function importCatalogExcel(req, res) {
  return handle(res, async () => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please choose an Excel (.xlsx) file to import.",
      });
    }

    try {
      const { rows } = await parseServicesWorkbook(req.file.buffer);
      const { created, updated } = await applyServicesImport(rows);

      const skipped = 0; // invalid files never reach the database
      const errors = 0;
      const summary = `${rows.length} service${rows.length === 1 ? "" : "s"} processed, ${updated} updated, ${created} created, ${skipped} skipped, ${errors} errors.`;
      return res.status(200).json({
        success: true,
        message:
          created === 0 && updated === 0
            ? "Import completed. No services were changed."
            : `Import completed successfully. ${summary}`,
        data: {
          processed: rows.length,
          updated,
          created,
          skipped,
          errors,
        },
      });
    } catch (error) {
      if (error instanceof CatalogImportError) {
        return res.status(400).json({
          success: false,
          message: error.message,
          errors: error.errors ?? [],
        });
      }
      throw error;
    }
  });
}
