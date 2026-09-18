// ==================================================
// Catalog Excel service — reference-format export & import
// ==================================================
// The Excel workbook is a USER-FACING catalogue editing format, not a
// database dump. Its structure is defined by the reference Excel
// (the-nail-hue-services-*.xlsx) and must never drift from it:
//
//   Sheet 1  "Services"    — exactly 17 columns, in exactly this order
//   Sheet 2  "How to edit" — the admin instructions sheet
//
// No other sheets, no internal ids, no images, no display order, no
// timestamps. Database structure ≠ Excel structure: the mappers below are
// the only place where the two meet.
//
//   DATABASE -> exportServicesWorkbook -> REFERENCE XLSX
//   REFERENCE XLSX -> importServicesWorkbook (validate all, then one
//   transaction) -> DATABASE
import ExcelJS from "exceljs";
import db from "../config/database.js";

// ---------- Reference format constants (single source of truth) ----------

export const SERVICES_SHEET = "Services";
export const HOW_TO_EDIT_SHEET = "How to edit";

// Exactly 17 columns, in exactly this order. Never add, remove or reorder.
export const SERVICE_COLUMNS = [
  "Category",
  "Sub-category",
  "Service Name",
  "Gender",
  "Price",
  "Price Type",
  "S Price",
  "M Price",
  "L Price",
  "Variant Labels",
  "Starting Price",
  "Duration",
  "Description",
  "Branch",
  "Status",
  "Notes",
  "Good to know",
];

const GENDER_VALUES = [
  "Men",
  "Women",
  "Unisex",
  "Girls",
  "Boys",
  "Women Only",
  "Men & Women",
];

const PRICE_TYPE_VALUES = ["Fixed", "Size (S/M/L)", "Variant", "From"];

const STATUS_VALUES = ["Active", "Inactive"];

// User-facing Branch cell -> internal branch slug. The DB keeps its own
// representation; the workbook always shows the reference wording.
const BRANCH_LABEL_BY_SLUG = {
  "indiranagar": "Indiranagar",
  "sarjapur-road": "Sarjapura Road",
};

// Internal pricing_type <-> user-facing Price Type column.
const PRICE_TYPE_LABEL = {
  "fixed": "Fixed",
  "size": "Size (S/M/L)",
  "variant": "Variant",
  "from": "From",
};

const PRICE_TYPE_INTERNAL = {
  "Fixed": "fixed",
  "Size (S/M/L)": "size",
  "Variant": "variant",
  "From": "from",
};

const SIZE_KEYS = ["S", "M", "L"];

const HOW_TO_EDIT_ROWS = [
  ["Field", "Accepted values / meaning"],
  ["Gender", "Men, Women, Unisex, Girls, Boys, Women Only, Men & Women"],
  ["Branch", "Both branches, Indiranagar, Sarjapura Road"],
  ["Status", "Active, Inactive"],
  ["Price Type", "Fixed, Size (S/M/L), Variant, From"],
  ["Price", "Use only when Price Type is Fixed"],
  ["S / M / L Price", "Use when Price Type is Size (S/M/L) or Variant"],
  ["Variant Labels", "What the prices vary by, separated by slashes"],
  ["Starting Price", "Use only when Price Type is From"],
  ["Notes", "Internal only. Never shown to clients"],
  [
    "On re-import",
    "A row updates an existing service when Category + Service Name + Gender all match",
  ],
];

// ---------- Small helpers ----------

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Matching key for Category + Service Name + Gender. Normalises case and
// surrounding whitespace, but keeps meaningful characters like "**" so that
// "Free Hand Nail Art-compli" and "Free Hand Nail Art-compli**" stay distinct
// (unlike a plain slugify, which would collapse them and report a false
// duplicate).
function serviceKey(category, name, gender) {
  const norm = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  return `${norm(category)}::${norm(name)}::${norm(gender)}`;
}

// Normalises any ExcelJS cell value to trimmed plain text.
export function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? "").join("").trim();
    }
    if (value.text !== undefined) return String(value.text).trim();
    if (value.result !== undefined && value.result !== null) {
      return String(value.result).trim();
    }
    return "";
  }
  return String(value).trim();
}

function parseMoney(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const text = cellText(value);
  if (!text) return null;
  const cleaned = text.replace(/[₹,\s]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function orNull(text) {
  const value = cellText(text);
  return value === "" ? null : value;
}

// Case-insensitive lookup that still returns the canonical spelling.
function canonicalValue(raw, allowed) {
  const text = cellText(raw);
  if (!text) return null;
  const lowered = text.toLowerCase();
  return allowed.find((value) => value.toLowerCase() === lowered) ?? null;
}

// "20 min / 30 min" -> ["20 min", "30 min"]; "S / M / L" -> S/M/L labels.
function parseVariantLabels(text) {
  return cellText(text)
    .split(/\s*\/\s*|\s*;\s*|\s*\n\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// ==================================================
// EXPORT — DATABASE -> reference workbook
// ==================================================

export async function fetchCatalogForExport(connection = db) {
  const [serviceRows] = await connection.query(
    `SELECT s.id, s.name, s.audience, s.description, s.pricing_type,
            s.price, s.price_range, s.duration, s.notes, s.good_to_know,
            s.is_active,
            c.name AS category_name,
            sc.name AS subcategory_name
     FROM services s
     INNER JOIN categories c ON c.id = s.category_id
     LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
     ORDER BY c.display_order, c.id, sc.id, s.display_order, s.id`,
  );

  const [variantRows] = await connection.query(
    `SELECT service_id, label, price
     FROM service_variants
     ORDER BY service_id, sort_order, id`,
  );

  const [branchRows] = await connection.query(
    `SELECT sb.service_id, b.slug
     FROM service_branches sb
     INNER JOIN branches b ON b.id = sb.branch_id
     ORDER BY sb.service_id, b.id`,
  );

  const variantsByService = new Map();
  for (const variant of variantRows) {
    if (!variantsByService.has(variant.service_id)) {
      variantsByService.set(variant.service_id, []);
    }
    variantsByService.get(variant.service_id).push({
      label: String(variant.label ?? "").trim(),
      price: variant.price != null ? Number(variant.price) : null,
    });
  }

  const branchSlugsByService = new Map();
  for (const link of branchRows) {
    if (!branchSlugsByService.has(link.service_id)) {
      branchSlugsByService.set(link.service_id, []);
    }
    branchSlugsByService.get(link.service_id).push(link.slug);
  }

  return serviceRows.map((row) => ({
    ...row,
    price: row.price != null ? Number(row.price) : null,
    variants: variantsByService.get(row.id) ?? [],
    branchSlugs: branchSlugsByService.get(row.id) ?? [],
  }));
}

// Maps one internal service row to the 17 reference cells. Blank when a
// value does not apply — never "N/A", "null" or "undefined".
export function mapServiceToRow(service) {
  const pricingType = PRICE_TYPE_LABEL[service.pricing_type] ?? "Fixed";
  const variants = (service.variants ?? []).filter((v) => v.label);

  // Reference convention: a size/variant service's prices sit in the S/M/L
  // columns in variant order, and Variant Labels carries the label text
  // ("S / M / L" for sizes, "20 min / 30 min" or "Two prices published"
  // for variants). Mapping is positional, so it round-trips exactly.
  const sizePrice = {};
  let variantText = "";
  if (service.pricing_type === "size" || service.pricing_type === "variant") {
    SIZE_KEYS.forEach((key, index) => {
      sizePrice[key] = variants[index]?.price ?? null;
    });
    if (service.pricing_type === "size") {
      variantText = SIZE_KEYS.slice(0, variants.length).join(" / ");
    } else {
      variantText = variants.map((variant) => variant.label).join(" / ");
    }
  }

  const branchSlugs = service.branchSlugs ?? [];
  let branchLabel = "";
  if (branchSlugs.length > 0) {
    const known = branchSlugs.filter((slug) => BRANCH_LABEL_BY_SLUG[slug]);
    if (known.length === branchSlugs.length && branchSlugs.length >= 2) {
      branchLabel = "Both branches";
    } else {
      branchLabel = known.map((slug) => BRANCH_LABEL_BY_SLUG[slug]).join(", ");
    }
  }

  return [
    service.category_name ?? "",
    service.subcategory_name ?? "",
    service.name ?? "",
    service.audience ?? "",
    // Price: fixed only. From uses Starting Price; size/variant stay blank.
    pricingType === "Fixed" && service.price != null ? service.price : "",
    pricingType,
    sizePrice.S ?? "",
    sizePrice.M ?? "",
    sizePrice.L ?? "",
    variantText,
    pricingType === "From" && service.price != null ? service.price : "",
    service.duration ?? "",
    service.description ?? "",
    branchLabel,
    service.is_active ? "Active" : "Inactive",
    service.notes ?? "",
    service.good_to_know ?? "",
  ];
}

export function buildServicesSheet(workbook, services) {
  const sheet = workbook.addWorksheet(SERVICES_SHEET);
  sheet.columns = SERVICE_COLUMNS.map((header) => ({ header }));
  for (const service of services) {
    sheet.addRow(mapServiceToRow(service));
  }
  return sheet;
}

export function buildHowToEditSheet(workbook) {
  const sheet = workbook.addWorksheet(HOW_TO_EDIT_SHEET);
  sheet.columns = [{ header: "Field" }, { header: "Accepted values / meaning" }];
  for (const row of HOW_TO_EDIT_ROWS.slice(1)) {
    sheet.addRow(row);
  }
  return sheet;
}

// Full export: reads the live database and returns the .xlsx buffer.
export async function exportServicesWorkbook() {
  const services = await fetchCatalogForExport();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TNH Salon Admin";
  buildServicesSheet(workbook, services);
  buildHowToEditSheet(workbook);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ==================================================
// IMPORT — reference workbook -> validation -> DATABASE
// ==================================================

export class CatalogImportError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "CatalogImportError";
    this.errors = errors;
  }
}

function readServicesSheet(workbook) {
  const sheet = workbook.getWorksheet(SERVICES_SHEET);
  if (!sheet) {
    throw new CatalogImportError(
      `The workbook has no "${SERVICES_SHEET}" sheet. Please upload the Excel file generated by the Export button.`,
    );
  }

  const headerRow = sheet.getRow(1);
  const headerIndex = new Map();
  for (let c = 1; c <= sheet.columnCount; c += 1) {
    const text = cellText(headerRow.getCell(c).text);
    if (text) headerIndex.set(text, c);
  }

  // Exact-format check: every reference column must be present.
  const missing = SERVICE_COLUMNS.filter((column) => !headerIndex.has(column));
  if (missing.length > 0) {
    throw new CatalogImportError(
      `The "${SERVICES_SHEET}" sheet is missing required column(s): ${missing.join(", ")}. Please use the file generated by the Export button.`,
    );
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    SERVICE_COLUMNS.forEach((column) => {
      record[column] = row.getCell(headerIndex.get(column)).value;
    });
    const hasContent = Object.values(record).some((value) => cellText(value) !== "");
    if (hasContent) rows.push({ rowNumber, record });
  });
  return rows;
}

// Recomputes the derived price_range string ("₹600 – ₹800") from the
// variant/size prices — the public site shows it when a service has no
// single price.
function buildPriceRange(priceType, variants) {
  if (priceType !== "size" && priceType !== "variant") return null;
  const prices = (variants ?? [])
    .map((v) => v.price)
    .filter((p) => p != null && Number.isFinite(p));
  if (prices.length === 0) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const format = (value) =>
    `₹${Number.isInteger(value) ? value : Number(value.toFixed(2))}`;
  return min === max ? format(min) : `${format(min)} – ${format(max)}`;
}

// Validates every row and returns parsed values. Nothing here touches the
// database — the caller only proceeds when `errors` is empty.
export function validateServicesRows(rows, allBranches) {
  const errors = [];
  const parsed = [];
  const seenKeys = new Map(); // key -> first row number

  const branchSlugByLabel = new Map();
  for (const branch of allBranches) {
    branchSlugByLabel.set(branch.name.toLowerCase(), branch.slug);
    if (BRANCH_LABEL_BY_SLUG[branch.slug]) {
      branchSlugByLabel.set(
        BRANCH_LABEL_BY_SLUG[branch.slug].toLowerCase(),
        branch.slug,
      );
    }
    branchSlugByLabel.set(slugify(branch.name), branch.slug);
  }
  const branchSlugs = new Set(allBranches.map((b) => b.slug));

  for (const { rowNumber, record } of rows) {
    const addError = (message) => errors.push(`Row ${rowNumber}: ${message}`);

    const category = cellText(record["Category"]);
    const name = cellText(record["Service Name"]);
    const gender = cellText(record["Gender"]);

    if (!category) addError("Missing Category");
    if (!name) addError("Missing Service Name");

    const genderCanonical = canonicalValue(gender, GENDER_VALUES);
    if (!gender) {
      addError("Missing Gender");
    } else if (!genderCanonical) {
      addError(`Invalid Gender "${gender}" (use: ${GENDER_VALUES.join(", ")})`);
    }

    const priceTypeLabel = canonicalValue(
      record["Price Type"],
      PRICE_TYPE_VALUES,
    );
    if (!priceTypeLabel) {
      addError(
        `Invalid Price Type "${cellText(record["Price Type"])}" (use: ${PRICE_TYPE_VALUES.join(", ")})`,
      );
    }

    const statusText = canonicalValue(record["Status"], STATUS_VALUES);
    if (cellText(record["Status"]) && !statusText) {
      addError(
        `Invalid Status "${cellText(record["Status"])}" (use: ${STATUS_VALUES.join(", ")})`,
      );
    }

    const branchText = cellText(record["Branch"]);
    const branchSlugsForRow = [];
    if (branchText) {
      const lower = branchText.toLowerCase();
      if (lower === "both branches" || lower === "both" || lower === "all") {
        branchSlugsForRow.push(...branchSlugs);
      } else {
        for (const part of branchText.split(/\s*[,;]\s*/).filter(Boolean)) {
          const slug = branchSlugByLabel.get(part.toLowerCase());
          if (!slug) {
            addError(
              `Invalid Branch "${part}" (use: Both branches, Indiranagar, Sarjapura Road)`,
            );
          } else if (!branchSlugsForRow.includes(slug)) {
            branchSlugsForRow.push(slug);
          }
        }
      }
    }
    if (branchSlugsForRow.length === 0) {
      addError("Missing Branch");
    }

    const priceType = PRICE_TYPE_INTERNAL[priceTypeLabel ?? ""] ?? null;
    const fixedPrice = parseMoney(record["Price"]);
    const sPrice = parseMoney(record["S Price"]);
    const mPrice = parseMoney(record["M Price"]);
    const lPrice = parseMoney(record["L Price"]);
    const startingPrice = parseMoney(record["Starting Price"]);
    const variantLabelText = cellText(record["Variant Labels"]);
    const variantLabels = parseVariantLabels(variantLabelText);

    // ---- Pricing rules per Price Type ----
    if (priceType === "fixed") {
      if (fixedPrice == null) addError("Price is required for Fixed services");
      if (startingPrice != null) {
        addError("Starting Price should be blank for Fixed services");
      }
    } else if (priceType === "from") {
      if (startingPrice == null) {
        addError("Starting Price is required for From services");
      }
      if (fixedPrice != null) {
        addError("Price should be blank for From services (use Starting Price)");
      }
    } else if (priceType === "size" || priceType === "variant") {
      if (sPrice == null || mPrice == null) {
        addError("S Price and M Price are required for Size/Variant services");
      }
      if (fixedPrice != null) {
        addError("Price should be blank for Size/Variant services");
      }
    }

    // Build the variant list the database stores for size/variant pricing.
    // Inverse of the positional export mapping: S/M/L columns are variant
    // 1/2/3. For Variant services with explicit labels ("20 min / 30 min"),
    // those labels are used; otherwise S/M/L labels are used.
    const variants = [];
    if (priceType === "size" || priceType === "variant") {
      const explicitLabels = variantLabels.filter(
        (label) => !SIZE_KEYS.some((s) => s.toLowerCase() === label.toLowerCase()),
      );
      const prices = [sPrice, mPrice, lPrice].filter((p) => p != null);
      const labels =
        priceType === "variant" && explicitLabels.length > 0
          ? explicitLabels
          : SIZE_KEYS.slice(0, Math.max(1, prices.length));
      labels.forEach((label, index) => {
        if (prices[index] != null) {
          variants.push({ label, price: prices[index] });
        }
      });
    }

    const key = serviceKey(category, name, genderCanonical ?? gender);    if (category && name && (genderCanonical || gender)) {
      if (seenKeys.has(key)) {
        addError(
          `Duplicate service: ${category} / ${name} / ${genderCanonical ?? gender} (already on row ${seenKeys.get(key)})`,
        );
      } else {
        seenKeys.set(key, rowNumber);
      }
    }

    parsed.push({
      rowNumber,
      key,
      category,
      subCategory: orNull(record["Sub-category"]),
      name,
      gender: genderCanonical ?? gender,
      priceType,
      price:
        priceType === "fixed" || priceType === "from"
          ? (fixedPrice ?? startingPrice)
          : null,
      priceRange: buildPriceRange(priceType, variants),
      variants,
      duration: orNull(record["Duration"]),
      description: orNull(record["Description"]),
      branchSlugs: branchSlugsForRow.filter((slug) => branchSlugs.has(slug)),
      isActive: statusText === null ? true : statusText === "Active",
      notes: orNull(record["Notes"]),
      goodToKnow: orNull(record["Good to know"]),
    });
  }

  return { parsed, errors };
}

// Parses + validates the whole workbook. Throws CatalogImportError (with
// row-level errors) before anything is written.
export async function parseServicesWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new CatalogImportError(
      "This file could not be read as an Excel workbook. Please upload the .xlsx generated by the Export button.",
    );
  }

  const rows = readServicesSheet(workbook);
  if (rows.length === 0) {
    throw new CatalogImportError(
      `The "${SERVICES_SHEET}" sheet contains no service rows.`,
    );
  }

  const [branchRows] = await db.query(
    `SELECT id, slug, name FROM branches WHERE is_active = TRUE ORDER BY id`,
  );
  const allBranches = branchRows.map((b) => ({
    id: Number(b.id),
    slug: b.slug,
    name: b.name,
  }));

  const { parsed, errors } = validateServicesRows(rows, allBranches);

  // Resolve categories/sub-categories against the live database (read-only)
  // and collect any unknown names, so the admin gets one complete problem
  // report instead of fixing issues one round-trip at a time.
  const [categoryRows] = await db.query(
    `SELECT id, name, slug FROM categories`,
  );

  // Tolerant category resolution: normalises dash variants ("Hair -" vs
  // "Hair –") and falls back to the base name before a parenthetical
  // ("Hands & Feet (pedi & mani)" -> "Hands & Feet"). Ambiguous fallbacks
  // are rejected, never guessed.
  const normalizeCategoryName = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[\u2013\u2014\u2212]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  const categoryByName = new Map(
    categoryRows.map((c) => [normalizeCategoryName(c.name), c]),
  );
  const categoryByBaseName = new Map();
  for (const category of categoryRows) {
    const base = normalizeCategoryName(category.name).replace(
      /\s*\([^)]*\)\s*$/,
      "",
    );
    if (categoryByBaseName.has(base)) {
      categoryByBaseName.set(base, null); // ambiguous — no fallback match
    } else {
      categoryByBaseName.set(base, category);
    }
  }
  const resolveCategory = (name) =>
    categoryByName.get(normalizeCategoryName(name)) ??
    categoryByBaseName.get(normalizeCategoryName(name).replace(/\s*\([^)]*\)\s*$/, "")) ??
    null;

  const [subRows] = await db.query(
    `SELECT sc.id, sc.name, sc.category_id FROM sub_categories sc`,
  );
  const subByCategoryAndName = new Map();
  for (const sub of subRows) {
    subByCategoryAndName.set(`${sub.category_id}::${sub.name.toLowerCase()}`, sub);
  }

  for (const row of parsed) {
    const category = resolveCategory(row.category);
    if (!category) {
      if (row.category) {
        errors.push(
          `Row ${row.rowNumber}: Unknown category "${row.category}" (must already exist in the database)`,
        );
      }
      continue;
    }
    row.categoryId = Number(category.id);

    row.subCategoryId = null;
    if (row.subCategory) {
      const sub = subByCategoryAndName.get(
        `${category.id}::${row.subCategory.toLowerCase()}`,
      );
      if (!sub) {
        errors.push(
          `Row ${row.rowNumber}: Unknown sub-category "${row.subCategory}" under "${row.category}"`,
        );
        continue;
      }
      row.subCategoryId = Number(sub.id);
    }
  }

  if (errors.length > 0) {
    errors.sort(
      (a, b) =>
        Number(a.match(/^Row (\d+)/)?.[1] ?? Infinity) -
        Number(b.match(/^Row (\d+)/)?.[1] ?? Infinity),
    );
    throw new CatalogImportError(
      `Import stopped: ${errors.length} problem${errors.length === 1 ? "" : "s"} found. Nothing was changed.`,
      errors,
    );
  }

  return { rows: parsed, branches: allBranches };
}

// Writes validated rows inside ONE transaction: every service is upserted by
// (category + name + gender); variants and branch links are replaced.
export async function applyServicesImport(parsedRows) {
  const connection = await db.getConnection();
  let created = 0;
  let updated = 0;

  try {
    await connection.beginTransaction();

    // Built in JS (via the same `serviceKey` used for import-row matching)
    // rather than as MySQL-specific REGEXP_REPLACE SQL, so both sides of the
    // match always agree on normalization.
    const [existingRows] = await connection.query(
      `SELECT s.id, s.name, s.audience, c.name AS category_name
       FROM services s
       INNER JOIN categories c ON c.id = s.category_id`,
    );
    const existingByKey = new Map(
      existingRows.map((s) => [
        serviceKey(s.category_name, s.name, s.audience),
        Number(s.id),
      ]),
    );

    for (const row of parsedRows) {
      const existingId = existingByKey.get(row.key);

      if (existingId) {
        await connection.query(
          `UPDATE services SET
             category_id = ?, sub_category_id = ?, audience = ?,
             pricing_type = ?, price = ?, price_range = ?, duration = ?,
             description = ?, is_active = ?, notes = ?, good_to_know = ?
           WHERE id = ?`,
          [
            row.categoryId,
            row.subCategoryId,
            row.gender,
            row.priceType,
            row.price,
            row.priceRange,
            row.duration,
            row.description,
            Boolean(row.isActive),
            row.notes,
            row.goodToKnow,
            existingId,
          ],
        );
        updated += 1;
      } else {
        const baseSlug = slugify(`${row.name}-${row.gender}`) || "service";
        let slug = baseSlug;
        let attempt = 1;
        // eslint-disable-next-line no-await-in-loop
        while (
          (
            await connection.query(`SELECT 1 FROM services WHERE slug = ? LIMIT 1`, [
              slug,
            ])
          )[0][0]
        ) {
          attempt += 1;
          slug = `${baseSlug}-${attempt}`.slice(0, 160);
        }

        // eslint-disable-next-line no-await-in-loop
        const [result] = await connection.query(
          `INSERT INTO services
             (slug, category_id, sub_category_id, name, audience, pricing_type,
              price, price_range, duration, description, is_active, notes, good_to_know)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            slug,
            row.categoryId,
            row.subCategoryId,
            row.name,
            row.gender,
            row.priceType,
            row.price,
            row.priceRange,
            row.duration,
            row.description,
            Boolean(row.isActive),
            row.notes,
            row.goodToKnow,
          ],
        );
        existingByKey.set(row.key, Number(result.insertId));
        created += 1;
      }

      const serviceId = existingByKey.get(row.key);

      await connection.query(`DELETE FROM service_variants WHERE service_id = ?`, [
        serviceId,
      ]);
      for (const [index, variant] of row.variants.entries()) {
        // eslint-disable-next-line no-await-in-loop
        await connection.query(
          `INSERT INTO service_variants (service_id, label, price, sort_order)
           VALUES (?, ?, ?, ?)`,
          [serviceId, variant.label, variant.price, index],
        );
      }

      await connection.query(`DELETE FROM service_branches WHERE service_id = ?`, [
        serviceId,
      ]);
      for (const branchSlug of row.branchSlugs) {
        // eslint-disable-next-line no-await-in-loop
        await connection.query(
          `INSERT INTO service_branches (service_id, branch_id)
           SELECT ?, id FROM branches WHERE slug = ?
           ON CONFLICT DO NOTHING`,
          [serviceId, branchSlug],
        );
      }
    }

    await connection.commit();
    return { created, updated, processed: parsedRows.length };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
