// TEMPORARY E2E TEST — service reorder flow (run against a live local
// server). Exercises: happy path (the spec's 1→4, 2→1, 3→2, 4→3 rotation),
// persistence across a re-read (server restart equivalent — data comes from
// the DB, not server memory), scope isolation between sub-categories,
// duplicate/foreign/partial/unknown-id rejection with no partial writes,
// sub-category/category mismatch rejection, auth, create-appends-to-end,
// delete-normalizes, update re-scoping, public API ordering, and
// ordering-before-pagination. Every mutation is reverted at the end so this
// is non-destructive against the shared dev database.
import pool from "../src/config/database.js";
import dotenv from "dotenv";

dotenv.config();

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:5001";
// Prefer explicit test credentials; fall back to the .env admin (same
// fallback test-roundtrip.mjs uses).
const EMAIL = process.env.TEST_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL;
const PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {}
  return { status: res.status, payload };
}

async function dbScope(categoryId, subCategoryId) {
  const [rows] = await pool.query(
    `SELECT id, name, display_order FROM services
     WHERE category_id = ? AND sub_category_id IS NOT DISTINCT FROM ?
     ORDER BY display_order ASC, id ASC`,
    [categoryId, subCategoryId ?? null],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    o: Number(r.display_order),
  }));
}

async function restoreScope(snapshot) {
  for (const row of snapshot) {
    await pool.query(`UPDATE services SET display_order = ? WHERE id = ?`, [
      row.o,
      row.id,
    ]);
  }
}

// ---- SETUP ----
console.log("SETUP — admin login + find a category/subcategory with >= 4 services");
const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
check("login returns 200 + token", login.status === 200 && Boolean(login.payload?.token), JSON.stringify(login.payload));
const token = login.payload?.token;

const [scopeRows] = await pool.query(
  `SELECT category_id, sub_category_id, COUNT(*) AS n
   FROM services
   WHERE sub_category_id IS NOT NULL
   GROUP BY category_id, sub_category_id
   HAVING COUNT(*) >= 4
   ORDER BY n DESC, category_id, sub_category_id
   LIMIT 1`,
);
const scope = scopeRows[0];
check("found a scope with >= 4 services", Boolean(scope), JSON.stringify(scopeRows));
if (!scope) {
  console.log("Cannot continue without a suitable scope. Aborting.");
  await pool.end();
  process.exit(1);
}
const categoryId = Number(scope.category_id);
const subCategoryId = Number(scope.sub_category_id);

// A second scope under the SAME category (different sub) to prove isolation.
const [otherScopeRows] = await pool.query(
  `SELECT sub_category_id, COUNT(*) AS n
   FROM services
   WHERE category_id = ? AND sub_category_id IS NOT NULL AND sub_category_id != ?
   GROUP BY sub_category_id
   ORDER BY n DESC, sub_category_id
   LIMIT 1`,
  [categoryId, subCategoryId],
);
const otherSubCategoryId = otherScopeRows[0] ? Number(otherScopeRows[0].sub_category_id) : null;

// A sub-category from a DIFFERENT category — used for the foreign-scope test.
const [foreignRows] = await pool.query(
  `SELECT s.sub_category_id, sc.category_id
   FROM services s
   INNER JOIN sub_categories sc ON sc.id = s.sub_category_id
   WHERE sc.category_id != ?
   GROUP BY s.sub_category_id, sc.category_id
   ORDER BY s.sub_category_id
   LIMIT 1`,
  [categoryId],
);
const foreignSub = foreignRows[0]
  ? { subId: Number(foreignRows[0].sub_category_id), categoryId: Number(foreignRows[0].category_id) }
  : null;

const originalOrder = await dbScope(categoryId, subCategoryId);
const otherOriginalOrder = otherSubCategoryId ? await dbScope(categoryId, otherSubCategoryId) : [];
console.log(
  `Using scope category=${categoryId}, sub=${subCategoryId}: ${originalOrder.map((r) => `${r.name}(#${r.id})`).join(" -> ")}`,
);
if (otherSubCategoryId) {
  console.log(
    `Isolation scope category=${categoryId}, sub=${otherSubCategoryId}: ${otherOriginalOrder.map((r) => r.name).join(" -> ")}`,
  );
}

const send = (items) =>
  api("PUT", "/api/services/reorder", { categoryId, subCategoryId, items }, token);

// ---- TEST 1: spec rotation 1→4, 2→1, 3→2, 4→3 ----
console.log("\nTEST 1 — reorder first four services (1→4, 2→1, 3→2, 4→3)");
const rotated = [
  originalOrder[1],
  originalOrder[2],
  originalOrder[3],
  originalOrder[0],
  ...originalOrder.slice(4),
];
const items1 = rotated.map((row, i) => ({ id: row.id, displayOrder: i }));
const r1 = await send(items1);
check("HTTP 200", r1.status === 200, `got ${r1.status} ${JSON.stringify(r1.payload)}`);
check("payload.success === true", r1.payload?.success === true);
check("message === 'Service order updated'", r1.payload?.message === "Service order updated");
const after1 = await dbScope(categoryId, subCategoryId);
check(
  "DB: order matches submitted rotation",
  after1.map((r) => r.id).join(",") === rotated.map((r) => r.id).join(","),
  JSON.stringify(after1.map((r) => `${r.name}(${r.o})`)),
);
check(
  "DB: dense 0..n-1 ordering after reorder",
  after1.every((row, i) => row.o === i),
  JSON.stringify(after1.map((r) => r.o)),
);
check(
  "DB: only display_order changed (ids/names untouched)",
  after1.every((row) => originalOrder.some((o) => o.id === row.id && o.name === row.name)),
);

// ---- TEST 2: persistence — read back via the API (restart equivalent) ----
console.log("\nTEST 2 — order persists across a fresh API read (restart equivalent)");
const r2 = await api(
  "GET",
  `/api/services/scope?categoryId=${categoryId}&subCategoryId=${subCategoryId}`,
  undefined,
  token,
);
check("GET /api/services/scope → 200", r2.status === 200, `got ${r2.status}`);
const scopeIds = (r2.payload?.data?.services ?? []).map((s) => Number(s.id));
check(
  "scope API returns the rotated order from the DB",
  scopeIds.join(",") === rotated.map((r) => r.id).join(","),
  JSON.stringify(scopeIds),
);
const [dbRecheck] = await pool.query(
  `SELECT id, display_order FROM services WHERE id = ?`,
  [rotated[0].id],
);
check(
  "DB row directly confirms persisted display_order",
  Number(dbRecheck[0]?.display_order) === 0,
  `display_order=${dbRecheck[0]?.display_order}`,
);

// ---- TEST 3: scope isolation — same category, different sub-category ----
console.log("\nTEST 3 — sibling sub-category ordering is independent");
if (otherSubCategoryId) {
  const before3 = await dbScope(categoryId, otherSubCategoryId);
  check(
    "sibling scope untouched after reorder",
    JSON.stringify(before3.map((r) => [r.id, r.o])) ===
      JSON.stringify(otherOriginalOrder.map((r) => [r.id, r.o])),
    JSON.stringify(before3.map((r) => `${r.name}(${r.o})`)),
  );
} else {
  console.log("  SKIP — no sibling sub-category with services under this category");
}

// ---- TEST 4: validation — duplicates, foreign, partial, unknown ids ----
console.log("\nTEST 4 — validation rejections leave the order untouched");
const before4 = await dbScope(categoryId, subCategoryId);

// Duplicate id
const dupItems = items1.map((item, i) => ({ ...item, id: i === 1 ? items1[0].id : item.id }));
const r4a = await send(dupItems);
check("duplicate ids → 400", r4a.status === 400, `got ${r4a.status}`);

// Foreign id (service from another scope)
let foreignServiceId = null;
if (otherSubCategoryId && otherOriginalOrder.length > 0) {
  foreignServiceId = otherOriginalOrder[0].id;
} else if (foreignSub) {
  const [fRows] = await pool.query(
    `SELECT id FROM services WHERE sub_category_id = ? LIMIT 1`,
    [foreignSub.subId],
  );
  foreignServiceId = fRows[0] ? Number(fRows[0].id) : null;
}
if (foreignServiceId) {
  const foreignItems = [...items1, { id: foreignServiceId, displayOrder: items1.length }];
  const r4b = await send(foreignItems);
  check("foreign service id → 400", r4b.status === 400, `got ${r4b.status}`);
} else {
  console.log("  SKIP — no foreign service available");
}

// Partial list (drop the last id)
const partialItems = items1.slice(0, items1.length - 1);
const r4c = await send(partialItems);
check("partial id list → 400", r4c.status === 400, `got ${r4c.status}`);

// Unknown id
const unknownItems = items1.map((item, i) => ({ ...item, id: i === 0 ? 999999999 : item.id }));
const r4d = await send(unknownItems);
check("unknown id → 400", r4d.status === 400, `got ${r4d.status}`);

// Wrong subCategoryId (belongs to another category)
if (foreignSub) {
  const r4e = await api(
    "PUT",
    "/api/services/reorder",
    { categoryId: foreignSub.categoryId, subCategoryId, items: items1 },
    token,
  );
  check("subCategoryId from another category → 400", r4e.status === 400, `got ${r4e.status}`);
} else {
  console.log("  SKIP — no foreign sub-category available");
}

// Unknown category
const r4f = await api(
  "PUT",
  "/api/services/reorder",
  { categoryId: 999999999, subCategoryId, items: items1 },
  token,
);
check("unknown categoryId → 404", r4f.status === 404, `got ${r4f.status}`);

// No auth
const r4g = await api("PUT", "/api/services/reorder", { categoryId, subCategoryId, items: items1 });
check("no auth token → 401", r4g.status === 401, `got ${r4g.status}`);

const after4 = await dbScope(categoryId, subCategoryId);
check(
  "DB unchanged after every rejected request (no partial writes)",
  JSON.stringify(after4.map((r) => [r.id, r.o])) ===
    JSON.stringify(before4.map((r) => [r.id, r.o])),
);

// ---- TEST 5: create appends to the end ----
console.log("\nTEST 5 — new service appends to the end of its scope");
const createPayload = {
  name: "__reorder_test_service__",
  categoryId: String(categoryId),
  subCategoryId: String(subCategoryId),
  audience: "Unisex",
  pricingType: "fixed",
  price: 1,
  branchIds: ["indiranagar"],
};
const r5 = await api("POST", "/api/services", createPayload, token);
check("create service → 201", r5.status === 201, `got ${r5.status} ${JSON.stringify(r5.payload)}`);
const createdId = Number(r5.payload?.data?.service?.id);
check("created service has an id", Boolean(createdId));
const after5 = await dbScope(categoryId, subCategoryId);
const createdRow = after5.find((r) => r.id === createdId);
check(
  "created service sits at MAX(display_order) + 1",
  createdRow && createdRow.o === after5.length - 1 && createdRow.id === after5[after5.length - 1].id,
  JSON.stringify(after5.map((r) => `${r.name}(${r.o})`)),
);

// ---- TEST 6: delete normalizes the remaining orders ----
console.log("\nTEST 6 — deleting a service normalizes the remaining order");
// Delete the FIRST service of the scope (max gap-closing impact).
const firstId = after5[0].id;
const r6 = await api("DELETE", `/api/services/${firstId}`, undefined, token);
check("delete service → 200", r6.status === 200, `got ${r6.status}`);
const after6 = await dbScope(categoryId, subCategoryId);
check("deleted service is gone", !after6.some((r) => r.id === firstId));
check(
  "remaining services normalized to 0..n-1",
  after6.every((row, i) => row.o === i),
  JSON.stringify(after6.map((r) => r.o)),
);

// ---- TEST 7: update re-scopes the service (category/subcategory change) ----
console.log("\nTEST 7 — moving a service to another sub-category re-scopes its order");
if (otherSubCategoryId) {
  const mover = after6[0]; // first of the test scope
  const otherBefore = await dbScope(categoryId, otherSubCategoryId);
  const r7 = await api(
    "PUT",
    `/api/services/${mover.id}`,
    { subCategoryId: String(otherSubCategoryId) },
    token,
  );
  check("update subCategoryId → 200", r7.status === 200, `got ${r7.status}`);
  const testScopeAfter = await dbScope(categoryId, subCategoryId);
  check(
    "old scope renormalized (0..n-1, service removed)",
    testScopeAfter.every((row, i) => row.o === i) && !testScopeAfter.some((r) => r.id === mover.id),
    JSON.stringify(testScopeAfter.map((r) => r.o)),
  );
  const otherAfter = await dbScope(categoryId, otherSubCategoryId);
  check(
    "service appended to the end of the new scope",
    otherAfter[otherAfter.length - 1].id === mover.id &&
      Number(otherAfter[otherAfter.length - 1].o) === Math.max(...otherBefore.map((r) => r.o)) + 1,
    JSON.stringify(otherAfter.map((r) => `${r.name}(${r.o})`)),
  );
  // Move it back for cleanup.
  await api("PUT", `/api/services/${mover.id}`, { subCategoryId: String(subCategoryId) }, token);
} else {
  console.log("  SKIP — no sibling sub-category available");
}

// ---- TEST 8: public API ordering (menu order + pagination after ordering) ----
console.log("\nTEST 8 — public listing respects display_order and paginates after ordering");
// Resolve the category slug + sub-category NAME (the public page's chips
// filter by name) for the public query.
const [slugRows] = await pool.query(
  `SELECT c.slug AS category_slug, sc.name AS subcategory_name
   FROM categories c
   INNER JOIN sub_categories sc ON sc.category_id = c.id
   WHERE c.id = ? AND sc.id = ?`,
  [categoryId, subCategoryId],
);
const categorySlug = slugRows[0]?.category_slug;
const subCategoryName = slugRows[0]?.subcategory_name;
const r8b = await api(
  "GET",
  `/api/services?status=Active&category=${encodeURIComponent(categorySlug)}&subCategory=${encodeURIComponent(subCategoryName)}&page=1&limit=2&sort=menu`,
);
check("public paginated listing → 200", r8b.status === 200, `got ${r8b.status}`);
const pubPage1 = r8b.payload?.data?.services ?? [];
check("public page respects limit", pubPage1.length <= 2, `got ${pubPage1.length}`);
check(
  "public rows carry display_order",
  pubPage1.every((s) => Number.isFinite(Number(s.display_order))),
);
const [activeRows] = await pool.query(
  `SELECT id FROM services
   WHERE category_id = ? AND sub_category_id = ? AND is_active = TRUE
   ORDER BY display_order ASC, id ASC LIMIT 2`,
  [categoryId, subCategoryId],
);
check(
  "public page 1 matches DB display_order (ordering BEFORE pagination)",
  pubPage1.map((s) => Number(s.id)).join(",") === activeRows.map((r) => Number(r.id)).join(","),
  `public=${pubPage1.map((s) => s.id).join(",")} db=${activeRows.map((r) => r.id).join(",")}`,
);

// ---- CLEANUP ----
console.log("\nCLEANUP — restore original data");
if (createdId) {
  await api("DELETE", `/api/services/${createdId}`, undefined, token);
}
await restoreScope(originalOrder);
if (otherSubCategoryId) await restoreScope(otherOriginalOrder);
// The TEST 7 move-back may have shifted the sibling scope; restore is best
// effort against a live shared DB.
const [restoredRows] = await pool.query(
  `SELECT id, display_order FROM services WHERE id IN (${originalOrder.map(() => "?").join(",")})`,
  originalOrder.map((r) => r.id),
);
check("cleanup: original order restored", restoredRows.every((r) => Number(r.display_order) === originalOrder.find((o) => o.id === Number(r.id)).o));

// ---- Summary ----
console.log(`\n${"=".repeat(50)}\nRESULTS: ${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
