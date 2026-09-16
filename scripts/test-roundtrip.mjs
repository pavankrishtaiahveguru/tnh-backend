// Round-trip test harness — exercises the live backend like the admin UI does.
// Usage: node scripts/test-roundtrip.mjs
import dotenv from "dotenv";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

dotenv.config();

const BASE = `http://localhost:${process.env.PORT || 5000}`;

function log(message) {
  console.log(message);
}

function assert(condition, label) {
  if (!condition) {
    log(`  ✗ FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    log(`  ✓ ${label}`);
  }
}

async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Login failed: ${payload?.message}`);
  return payload.token;
}

async function exportXlsx(token) {
  const response = await fetch(`${BASE}/api/catalog/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Export failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "";
  return { buffer, filename };
}

async function importXlsx(token, buffer, name = "import.xlsx") {
  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    name,
  );
  const response = await fetch(`${BASE}/api/catalog/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

// Reads the Services sheet into an array of objects keyed by column name.
async function loadExport(buffer) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  const cols = [];
  sheet.getRow(1).eachCell((cell, index) => {
    cols[index] = String(cell.value ?? "");
  });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = { __row: rowNumber };
    cols.forEach((name, index) => {
      obj[name] = row.getCell(index)?.value ?? "";
    });
    rows.push(obj);
  });
  return { wb, rows, sheetNames: wb.worksheets.map((s) => s.name) };
}

const EXPECTED_COLUMNS = [
  "Category", "Sub-category", "Service Name", "Gender", "Price",
  "Price Type", "S Price", "M Price", "L Price", "Variant Labels",
  "Starting Price", "Duration", "Description", "Branch", "Status",
  "Notes", "Good to know",
];

async function main() {
  const token = await login();
  log("Logged in.");

  // ---------- TEST 1: export shape ----------
  log("\nTEST 1 — Export produces the exact reference format");
  const { buffer, filename } = await exportXlsx(token);
  log(`  Downloaded ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);

  const first = await loadExport(buffer);
  assert(first.sheetNames.length === 2, `exactly 2 sheets (got ${first.sheetNames.length})`);
  assert(first.sheetNames[0] === "Services", `sheet 1 = "Services"`);
  assert(first.sheetNames[1] === "How to edit", `sheet 2 = "How to edit"`);

  const servicesSheet = (await loadExport(buffer)).wb.worksheets[0];
  const headers = [];
  servicesSheet.getRow(1).eachCell((cell) => headers.push(cell.value));
  assert(
    JSON.stringify(headers) === JSON.stringify(EXPECTED_COLUMNS),
    `17 columns in exact order (got ${headers.length})`,
  );

  const FORBIDDEN = ["ID", "Image", "Image URL", "Display Order", "createdAt", "updatedAt", "Slug"];
  assert(
    headers.filter((h) => FORBIDDEN.includes(h)).length === 0,
    "no internal DB fields exported",
  );

  const howToEdit = (await loadExport(buffer)).wb.worksheets[1];
  const howToEditHeaders = [];
  howToEdit.getRow(1).eachCell((cell) => howToEditHeaders.push(cell.value));
  assert(
    howToEditHeaders[0] === "Field" && howToEditHeaders[1] === "Accepted values / meaning",
    '"How to edit" sheet matches reference structure',
  );

  log(`  Services rows: ${first.rows.length}`);
  assert(first.rows.length === 238, "all 238 DB services exported");

  const originalRows = first.rows;
  const firstKey = (r) => `${r["Service Name"]}|${r["Gender"]}`;

  // ---------- TEST 2: re-import the untouched export ----------
  log("\nTEST 2 — Re-import the exported file unchanged");
  const t2 = await importXlsx(token, buffer, "roundtrip.xlsx");
  if (t2.status !== 200) {
    log(`  Message: ${t2.payload?.message}`);
    for (const e of (t2.payload?.errors ?? []).slice(0, 10)) log(`    - ${e}`);
  }
  assert(t2.status === 200, `import accepted (status ${t2.status})`);
  assert(t2.payload?.data?.created === 0, "no services created (no duplicates)");
  assert(t2.payload?.data?.updated === 238, "all 238 services updated in place");
  assert(t2.payload?.data?.errors === 0, "no errors");

  // ---------- TEST 3: edit one service, re-import ----------
  log("\nTEST 3 — Edit one service's price, re-import");
  const editWb = (await loadExport(buffer)).wb;
  const editSheet = editWb.worksheets[0];
  const targetRow = editSheet.getRow(2);
  const targetName = String(targetRow.getCell(3).value);
  const targetGender = String(targetRow.getCell(4).value);
  const before = targetRow.getCell(5).value;
  targetRow.getCell(5).value = 599;
  const editedBuffer = Buffer.from(await editWb.xlsx.writeBuffer());
  const t3 = await importXlsx(token, editedBuffer, "edit.xlsx");
  if (t3.status !== 200) {
    log(`  Message: ${t3.payload?.message}`);
  }
  assert(t3.status === 200, `import accepted (status ${t3.status})`);
  assert(t3.payload?.data?.updated === 238, "all rows matched as updates");
  assert(t3.payload?.data?.created === 0, "no duplicate created");
  log(`  Changed "${targetName}" (${targetGender}) Price ${before} -> 599`);

  const checkExport = await exportXlsx(token);
  const check = await loadExport(checkExport.buffer);
  const changed = check.rows.find(
    (r) => firstKey(r) === `${targetName}|${targetGender}`,
  );
  assert(changed && Number(changed["Price"]) === 599, "price change persisted to DB");

  // ---------- TEST 4: add a new service row, import ----------
  log("\nTEST 4 — Add a new service row, import");
  const addWb = check.wb;
  const addSheet = addWb.worksheets[0];
  addSheet.addRow([
    "Waxing", "Women — waxing", "ZZ Test Service Alpha", "Women", 1234, "Fixed",
    "", "", "", "", "", "25 min", "Test description.", "Both branches", "Active",
    "test note", "test good to know",
  ]);
  const addBuffer = Buffer.from(await addWb.xlsx.writeBuffer());
  const t4 = await importXlsx(token, addBuffer, "add.xlsx");
  if (t4.status !== 200) {
    log(`  Message: ${t4.payload?.message}`);
    for (const e of (t4.payload?.errors ?? []).slice(0, 10)) log(`    - ${e}`);
  }
  assert(t4.status === 200, `import accepted (status ${t4.status})`);
  assert(t4.payload?.data?.created === 1, "1 service created");
  assert(t4.payload?.data?.updated === 238, "238 existing services updated (no duplicates)");

  const afterAdd = await loadExport((await exportXlsx(token)).buffer);
  const createdRow = afterAdd.rows.find(
    (r) => String(r["Service Name"]) === "ZZ Test Service Alpha",
  );
  assert(!!createdRow, "new service appears in export");
  assert(
    createdRow && Number(createdRow["Price"]) === 1234 &&
      String(createdRow["Category"]) === "Waxing",
    "new service data round-trips correctly",
  );
  assert(
    String(createdRow?.["Notes"] ?? "") === "test note" &&
      String(createdRow?.["Good to know"] ?? "") === "test good to know",
    "Notes / Good to know round-trip",
  );

  // ---------- TEST 5: invalid workbook -> nothing changes ----------
  log("\nTEST 5 — Invalid workbook is rejected, database untouched");
  const ExcelJS = (await import("exceljs")).default;
  const badWb = new ExcelJS.Workbook();
  const badSheet = badWb.addWorksheet("Services");
  badSheet.addRow(EXPECTED_COLUMNS);
  badSheet.addRow(["Waxing", "Women — waxing", "Bad Gender Row", "Malee", 100, "Fixed", "", "", "", "", "", "10 min", "", "Both branches", "Active", "", ""]);
  badSheet.addRow(["Waxing", "Women — waxing", "Bad Price Type Row", "Women", 100, "Variable", "", "", "", "", "", "10 min", "", "Both branches", "Active", "", ""]);
  badSheet.addRow(["Waxing", "Women — waxing", "", "Women", 100, "Fixed", "", "", "", "", "", "10 min", "", "Both branches", "Active", "", ""]);
  badSheet.addRow(["NoSuchCategory", "", "Orphan Service", "Women", 100, "Fixed", "", "", "", "", "", "10 min", "", "Both branches", "Active", "", ""]);
  badSheet.addRow(["Waxing", "Women — waxing", "Dup Row", "Women", 100, "Fixed", "", "", "", "", "", "10 min", "", "Both branches", "Active", "", ""]);
  badSheet.addRow(["Waxing", "Women — waxing", "Dup Row", "Women", 200, "Fixed", "", "", "", "", "", "10 min", "", "Both branches", "Active", "", ""]);
  const badBuffer = Buffer.from(await badWb.xlsx.writeBuffer());
  const t5 = await importXlsx(token, badBuffer, "bad.xlsx");
  assert(t5.status === 400, `invalid file rejected (status ${t5.status})`);
  const errorList = t5.payload?.errors ?? [];
  log(`  Errors reported (${errorList.length}):`);
  for (const e of errorList.slice(0, 10)) log(`    - ${e}`);
  assert(errorList.some((e) => e.includes('Invalid Gender "Malee"')), 'reports Invalid Gender "Malee"');
  assert(errorList.some((e) => e.includes('Invalid Price Type "Variable"')), 'reports Invalid Price Type "Variable"');
  assert(errorList.some((e) => e.includes("Missing Service Name")), "reports Missing Service Name");
  assert(errorList.some((e) => e.includes("Duplicate service")), "reports duplicate rows");
  assert(errorList.some((e) => e.includes("NoSuchCategory")), "reports unknown category");

  // Database must be unchanged by the rejected import.
  const afterBad = await loadExport((await exportXlsx(token)).buffer);
  assert(afterBad.rows.length === afterAdd.rows.length, "no rows added by invalid import");
  assert(
    afterBad.rows.some((r) => String(r["Service Name"]) === "ZZ Test Service Alpha"),
    "existing data intact after rejected import",
  );
  const badChanged = afterBad.rows.find((r) => firstKey(r) === `${targetName}|${targetGender}`);
  assert(badChanged && Number(badChanged["Price"]) === 599, "existing data not modified by rejected import");

  // ---------- Cleanup: restore edited price, delete test service ----------
  log("\nCleanup — restore edited price");
  const restoreWb = (await loadExport(checkExport.buffer)).wb;
  const restoreSheet = restoreWb.worksheets[0];
  restoreSheet.getRow(2).getCell(5).value = before;
  const restoreBuffer = Buffer.from(await restoreWb.xlsx.writeBuffer());
  const tRestore = await importXlsx(token, restoreBuffer, "restore.xlsx");
  assert(tRestore.status === 200, "restore import accepted");

  const zz = await fetch(
    `${BASE}/api/services?search=${encodeURIComponent("ZZ Test Service Alpha")}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  const zzId = zz?.data?.services?.[0]?.id;
  if (zzId) {
    const del = await fetch(`${BASE}/api/services/${zzId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(del.status === 200, "test service deleted (cleanup)");
  } else {
    log("  ! could not find test service to clean up");
  }

  // ---------- TEST 6: final export still matches the reference format ----------
  log("\nTEST 6 — Final export still matches the reference format");
  const finalExport = await loadExport((await exportXlsx(token)).buffer);
  assert(finalExport.sheetNames.length === 2, "still exactly 2 sheets");
  const finalHeaders = [];
  finalExport.wb.worksheets[0].getRow(1).eachCell((cell) => finalHeaders.push(cell.value));
  assert(
    JSON.stringify(finalHeaders) === JSON.stringify(EXPECTED_COLUMNS),
    "column order still exactly matches the reference",
  );
  const restored = finalExport.rows.find((r) => firstKey(r) === `${targetName}|${targetGender}`);
  assert(restored && Number(restored["Price"]) === before, "edited price restored in DB");

  const finalCount = finalExport.rows.length;
  log(`  Final service count: ${finalCount}`);
  assert(finalCount === 238, "database back to 238 services");

  log("\nDone.");
}

main().catch((error) => {
  console.error("Test harness error:", error);
  process.exitCode = 1;
});
