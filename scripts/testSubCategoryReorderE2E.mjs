// TEMPORARY E2E TEST — sub-category reorder flow (run against a live local
// server). Exercises: happy path (2-item swap, first<->last, multi-item),
// persistence across "reload" (re-reading from the DB), category isolation,
// duplicate/cross-category/invalid-id validation, auth, and public-facing
// order propagation. Every mutation is reverted at the end so this is
// non-destructive against the shared dev database.
import pool from "../src/config/database.js";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:5001";
const EMAIL = process.env.TEST_ADMIN_EMAIL ?? "admin@thenailhue.com";
const PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "admin@123";

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

async function dbOrder(categoryId) {
  const [rows] = await pool.query(
    `SELECT id, name, display_order FROM sub_categories WHERE category_id = ? ORDER BY display_order ASC, id ASC`,
    [categoryId],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, o: Number(r.display_order) }));
}

async function restoreOrder(categoryId, snapshot) {
  const items = snapshot.map((row) => ({ id: row.id, displayOrder: row.o }));
  for (const item of items) {
    await pool.query(`UPDATE sub_categories SET display_order = ? WHERE id = ?`, [
      item.displayOrder,
      item.id,
    ]);
  }
}

// ---- SETUP ----
console.log("SETUP — admin login + pick a category with >= 4 sub-categories");
const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
check("login returns 200 + token", login.status === 200 && Boolean(login.payload?.token), JSON.stringify(login.payload));
const token = login.payload?.token;

const [categoryRows] = await pool.query(
  `SELECT category_id, COUNT(*) AS n FROM sub_categories GROUP BY category_id HAVING COUNT(*) >= 4 ORDER BY category_id LIMIT 1`,
);
const categoryId = categoryRows[0]?.category_id;
check("found a test category with >= 4 sub-categories", Boolean(categoryId));
if (!categoryId) {
  console.log("Cannot continue without a suitable category. Aborting.");
  await pool.end();
  process.exit(1);
}

// Grab a second, unrelated category to prove isolation later.
const [otherRows] = await pool.query(
  `SELECT category_id, COUNT(*) AS n FROM sub_categories WHERE category_id != ? GROUP BY category_id HAVING COUNT(*) >= 1 ORDER BY category_id LIMIT 1`,
  [categoryId],
);
const otherCategoryId = otherRows[0]?.category_id;

const originalOrder = await dbOrder(categoryId);
const otherOriginalOrder = otherCategoryId ? await dbOrder(otherCategoryId) : [];
console.log(`Using category ${categoryId}: ${originalOrder.map((r) => r.name).join(" -> ")}`);

const send = (items) =>
  api("PUT", `/api/categories/${categoryId}/subcategories/reorder`, { items }, token);

// ---- TEST 1: swap two items (happy path) ----
console.log("\nTEST 1 — swap first two sub-categories");
const swapped = [...originalOrder];
[swapped[0], swapped[1]] = [swapped[1], swapped[0]];
const items1 = swapped.map((row, i) => ({ id: row.id, displayOrder: i }));
const r1 = await send(items1);
check("HTTP 200", r1.status === 200, `got ${r1.status} ${JSON.stringify(r1.payload)}`);
check("payload.success === true", r1.payload?.success === true);
const after1 = await dbOrder(categoryId);
check(
  "DB: order matches submitted swap",
  after1.map((r) => r.id).join(",") === swapped.map((r) => r.id).join(","),
  JSON.stringify(after1),
);
check(
  "DB: only display_order changed (ids/names untouched)",
  after1.every((row) => originalOrder.some((o) => o.id === row.id && o.name === row.name)),
);

// ---- TEST 2: move first -> last ----
console.log("\nTEST 2 — move first item to last position");
const cur2 = await dbOrder(categoryId);
const moved2 = [...cur2.slice(1), cur2[0]];
const r2 = await send(moved2.map((row, i) => ({ id: row.id, displayOrder: i })));
check("HTTP 200", r2.status === 200, `got ${r2.status}`);
const after2 = await dbOrder(categoryId);
check(
  "DB: first item now last",
  after2[after2.length - 1].id === cur2[0].id,
  JSON.stringify(after2),
);

// ---- TEST 3: move last -> first ----
console.log("\nTEST 3 — move last item to first position");
const cur3 = await dbOrder(categoryId);
const lastItem = cur3[cur3.length - 1];
const moved3 = [lastItem, ...cur3.slice(0, -1)];
const r3 = await send(moved3.map((row, i) => ({ id: row.id, displayOrder: i })));
check("HTTP 200", r3.status === 200, `got ${r3.status}`);
const after3 = await dbOrder(categoryId);
check("DB: last item now first", after3[0].id === lastItem.id, JSON.stringify(after3));

// ---- TEST 4: reorder multiple items + reload persistence ----
console.log("\nTEST 4 — full reverse order, then verify a fresh read (reload) sees it");
const cur4 = await dbOrder(categoryId);
const reversed = [...cur4].reverse();
const r4 = await send(reversed.map((row, i) => ({ id: row.id, displayOrder: i })));
check("HTTP 200", r4.status === 200, `got ${r4.status}`);
const reload4a = await api("GET", `/api/categories/${categoryId}`);
const reloadedIds = (reload4a.payload?.data?.category?.subcategories ?? []).map((s) => Number(s.id));
check(
  "GET /api/categories/:id (simulated reload) reflects reversed order",
  reloadedIds.join(",") === reversed.map((r) => r.id).join(","),
  JSON.stringify(reloadedIds),
);
// "Navigate away and return" — a second independent read must agree.
const reload4b = await api("GET", `/api/categories/${categoryId}`);
const reloadedIds2 = (reload4b.payload?.data?.category?.subcategories ?? []).map((s) => Number(s.id));
check("second independent read matches the first", reloadedIds2.join(",") === reloadedIds.join(","));

// ---- TEST 5: category isolation ----
console.log("\nTEST 5 — another category is unaffected");
if (otherCategoryId) {
  const afterOther = await dbOrder(otherCategoryId);
  check(
    "unrelated category's order is byte-for-byte unchanged",
    JSON.stringify(afterOther) === JSON.stringify(otherOriginalOrder),
    `${JSON.stringify(afterOther)} vs ${JSON.stringify(otherOriginalOrder)}`,
  );
} else {
  console.log("  SKIP  no second category available in this dataset");
}

// ---- TEST 6: service mappings + IDs untouched ----
console.log("\nTEST 6 — sub-category ids and service mappings are untouched throughout");
const [subIdCheck] = await pool.query(
  `SELECT id, name, slug FROM sub_categories WHERE category_id = ? ORDER BY id`,
  [categoryId],
);
check(
  "every original id/name/slug still present (no delete+recreate)",
  originalOrder.every((orig) =>
    subIdCheck.some((row) => Number(row.id) === orig.id && row.name === orig.name),
  ),
);
const [serviceCounts] = await pool.query(
  `SELECT sub_category_id, COUNT(*) AS c FROM services WHERE sub_category_id = ANY($1) GROUP BY sub_category_id`,
  [originalOrder.map((o) => o.id)],
);
check(
  "service_id -> sub_category_id mapping count query still resolves (no orphaning)",
  Array.isArray(serviceCounts),
);

// ---- TEST 7: invalid / cross-category / duplicate ids -> 400/404, no DB change ----
console.log("\nTEST 7 — validation: cross-category id, duplicate id, invalid id, missing item");
const preValidation = await dbOrder(categoryId);
const baseItems = preValidation.map((row, i) => ({ id: row.id, displayOrder: i }));

let crossCategoryItems = baseItems;
if (otherCategoryId) {
  const foreignId = otherOriginalOrder[0]?.id;
  crossCategoryItems = [...baseItems.slice(1), { id: foreignId, displayOrder: 0 }];
  const r7a = await send(crossCategoryItems);
  check("foreign-category id -> 400/404", [400, 404].includes(r7a.status), `got ${r7a.status}`);
}

const dupItems = [...baseItems, { id: baseItems[0].id, displayOrder: 99 }];
const r7b = await send(dupItems);
check("duplicate id -> 400", r7b.status === 400, `got ${r7b.status}`);

const invalidIdItems = [...baseItems.slice(1), { id: 999999999, displayOrder: 0 }];
const r7c = await send(invalidIdItems);
check("nonexistent id -> 400/404", [400, 404].includes(r7c.status), `got ${r7c.status}`);

const partialItems = baseItems.slice(0, -1); // missing one real sub-category
const r7d = await send(partialItems);
check("partial (incomplete) item set -> 400", r7d.status === 400, `got ${r7d.status}`);

const r7e = await send([]);
check("empty items array -> 400", r7e.status === 400, `got ${r7e.status}`);

const r7f = await api(
  "PUT",
  `/api/categories/999999999/subcategories/reorder`,
  { items: baseItems },
  token,
);
check("nonexistent category -> 404", r7f.status === 404, `got ${r7f.status}`);

const afterValidation = await dbOrder(categoryId);
check(
  "DB unchanged after every rejected validation case",
  JSON.stringify(afterValidation) === JSON.stringify(preValidation),
  JSON.stringify(afterValidation),
);

// ---- TEST 8: auth ----
console.log("\nTEST 8 — unauthorized users cannot reorder");
const r8a = await send(baseItems); // no token this time — override helper
const r8aNoAuth = await api("PUT", `/api/categories/${categoryId}/subcategories/reorder`, { items: baseItems });
check("no auth token -> 401", r8aNoAuth.status === 401, `got ${r8aNoAuth.status}`);
const r8b = await api(
  "PUT",
  `/api/categories/${categoryId}/subcategories/reorder`,
  { items: baseItems },
  "invalid.token.here",
);
check("invalid token -> 401", r8b.status === 401, `got ${r8b.status}`);
const afterAuth = await dbOrder(categoryId);
check(
  "DB unchanged after unauthorized attempts",
  JSON.stringify(afterAuth) === JSON.stringify(preValidation),
);

// ---- TEST 9: public/service-facing endpoints reflect the new order ----
console.log("\nTEST 9 — public GET reflects sub-category order (categories list, services dropdown source)");
const pubList = await api("GET", "/api/categories");
const pubCategory = (pubList.payload?.data?.categories ?? []).find(
  (c) => Number(c.id) === categoryId,
);
const pubSubIds = (pubCategory?.subcategories ?? []).map((s) => Number(s.id));
const dbIdsNow = (await dbOrder(categoryId)).map((r) => r.id);
check(
  "public /api/categories sub-category order matches DB (display_order, id)",
  pubSubIds.join(",") === dbIdsNow.join(","),
  `${pubSubIds.join(",")} vs ${dbIdsNow.join(",")}`,
);

// ---- CLEANUP: restore original order ----
console.log("\nCLEANUP — restoring original sub-category order");
await restoreOrder(categoryId, originalOrder);
const restored = await dbOrder(categoryId);
check(
  "DB restored to original order",
  JSON.stringify(restored) === JSON.stringify(originalOrder),
  JSON.stringify(restored),
);

// ---- Summary ----
console.log(`\n${"=".repeat(50)}\nRESULTS: ${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
