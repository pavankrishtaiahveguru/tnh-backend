// Validates the uploaded reference Excel against the import pipeline
// WITHOUT writing anything to the database (parse + validate only).
// Usage: node scripts/test-reference-file.mjs /path/to/reference.xlsx
import dotenv from "dotenv";
import fs from "node:fs";
import { parseServicesWorkbook } from "../src/services/catalogExcelService.js";

dotenv.config();

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/test-reference-file.mjs <file.xlsx>");
  process.exit(1);
}

const buffer = fs.readFileSync(file);

try {
  const { rows } = await parseServicesWorkbook(buffer);
  console.log(`✓ Reference file passes validation: ${rows.length} service rows`);

  // Spot-check pricing preservation from the reference file.
  const wash = rows.find((r) => r.name === "Wash & Plain Dry" && r.gender === "Women");
  console.log("Size service:", JSON.stringify(wash && {
    category: wash.category, priceType: wash.priceType,
    variants: wash.variants, duration: wash.duration, branch: wash.branchSlugs,
  }));
  const head = rows.find((r) => r.name === "Head Massage-Oil" && r.gender === "Men");
  console.log("Variant service:", JSON.stringify(head && {
    category: head.category, priceType: head.priceType,
    variants: head.variants, duration: head.duration,
  }));
  const cut = rows.find((r) => r.name === "Haircut" && r.gender === "Men");
  console.log("Fixed service:", JSON.stringify(cut && {
    category: cut.category, priceType: cut.priceType, price: cut.price,
  }));
} catch (error) {
  console.error(`✗ Validation failed: ${error.message}`);
  for (const e of (error.errors ?? []).slice(0, 20)) console.error(`  - ${e}`);
  process.exit(1);
}

process.exit(0);
