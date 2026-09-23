// TEMPORARY E2E TEST — subcategory creation + service mapping flow.
// Verifies: diff-sync preserves sub ids & services, new subs INSERT correctly,
// in-use subs cannot be removed (409), service subcategory resolution is
// parent-category-strict, and the public API reflects the new state.
import pool from "../src/config/database.js";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:5001";
const EMAIL = process.env.TEST_ADMIN_EMAIL ?? "thenailhue@gmail.com";
const PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "";

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

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
  try { payload = await res.json(); } catch {}
  return { status: res.status, payload };
}

const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
check("admin login", login.status === 200 && Boolean(login.payload?.token), JSON.stringify(login.payload));
const token = login.payload?.token;
if (!token) { console.log("CANNOT CONTINUE WITHOUT TOKEN"); process.exit(1); }

// ---- Grab the Massages category (8 services, has Men/Women subs) ----
const catsRes = await api("GET", "/api/categories");
const cats = catsRes.payload?.data?.categories ?? [];
const massages = cats.find((c) => c.slug === "head-massages");
check("found head-massages category", Boolean(massages));
const beforeSubIds = massages.subcategories.map((s) => Number(s.id)).sort();
console.log(`  (before: ${massages.subcategories.map((s) => s.name).join(", ")})`);

// ---- TEST 1: add a new subcategory via PUT (the Admin UI's flow) ----
console.log("\nTEST 1 — PUT category with one NEW subcategory added");
const updatedList = [
  ...massages.subcategories.map((s) => ({ id: s.id, name: s.name })),
  { name: "TEST-SUB-E2E" },
];
const put1 = await api("PUT", `/api/categories/${massages.id}`, {
  name: massages.name,
  description: massages.description ?? "",
  isActive: massages.is_active !== false,
  subCategories: updatedList,
}, token);
check("PUT returns 200", put1.status === 200, JSON.stringify(put1.payload).slice(0, 200));
const after1 = put1.payload?.data?.category?.subcategories ?? [];
const newSub = after1.find((s) => s.name === "TEST-SUB-E2E");
check("new subcategory present in response", Boolean(newSub));

const dbNewSub = (
  await pool.query(`SELECT id, category_id, name, slug FROM sub_categories WHERE name = ?`, ["TEST-SUB-E2E"]))
  .flat()[0];
check("DB row created", Boolean(dbNewSub));
check("DB category_id correct", Boolean(dbNewSub) && Number(dbNewSub.category_id) === Number(massages.id));

// ---- TEST 2: existing subs kept their IDs (services not detached) ----
console.log("\nTEST 2 — existing sub IDs preserved after save");
const afterSubIds = after1.filter((s) => s.name !== "TEST-SUB-E2E").map((s) => Number(s.id)).sort();
check("existing sub ids unchanged", JSON.stringify(beforeSubIds) === JSON.stringify(afterSubIds), `${JSON.stringify(beforeSubIds)} vs ${JSON.stringify(afterSubIds)}`);
const svcCounts = (
  await pool.query(`SELECT COUNT(*) AS c FROM services WHERE sub_category_id = ANY($1::int[])`, [beforeSubIds]))
  .flat()[0];
check("services still mapped to existing subs", Number(svcCounts?.c ?? 0) > 0, `count=${svcCounts?.c}`);

// ---- TEST 3: removing an in-use subcategory → 409, DB unchanged ----
console.log("\nTEST 3 — removing an in-use subcategory is blocked");
const inUseSub = after1.find((s) => s.name === "Men" || s.name === "Women");
const put3 = await api("PUT", `/api/categories/${massages.id}`, {
  name: massages.name,
  description: massages.description ?? "",
  isActive: massages.is_active !== false,
  subCategories: after1.filter((s) => s.id !== inUseSub.id).map((s) => ({ id: s.id, name: s.name })),
}, token);
check("PUT without in-use sub → 409", put3.status === 409, `got ${put3.status} ${JSON.stringify(put3.payload).slice(0, 150)}`);
const stillThere = (
  await pool.query(`SELECT COUNT(*) AS c FROM sub_categories WHERE id = ?`, [inUseSub.id]))
  .flat()[0];
check("in-use sub still exists in DB", Number(stillThere?.c) === 1);

// ---- TEST 4: service update with subcategory from ANOTHER category → rejected ----
console.log("\nTEST 4 — cross-category subCategoryId rejected (strict parent check)");
const someService = (await api("GET", "/api/services?category=head-massages")).payload?.data?.services?.[0];
check("found a massage service", Boolean(someService));
const otherCatSub = cats.find((c) => c.slug === "nails")?.subcategories?.[0];
check("found a nails subcategory", Boolean(otherCatSub));
const put4 = await api("PUT", `/api/services/${someService.id}`, {
  subCategoryId: Number(otherCatSub.id),
}, token);
check("cross-category sub update → 400/404", put4.status === 400 || put4.status === 404, `got ${put4.status}`);
// someService comes from the RAW API row: `id` is the numeric DB id (not slug).
const svcAfter4 = (
  await pool.query(`SELECT slug, sub_category_id FROM services WHERE id = ?`, [Number(someService.id)]))
  .flat()[0];
check("service row found for verification", Boolean(svcAfter4));
check(
  "service sub_category_id unchanged (not set to foreign sub)",
  Boolean(svcAfter4) && Number(svcAfter4.sub_category_id) !== Number(otherCatSub.id),
  `db sub=${svcAfter4?.sub_category_id} vs foreign sub=${otherCatSub.id}`,
);

// ---- TEST 5: cleanup test subcategory (unused → removal allowed) ----
console.log("\nTEST 5 — cleanup: remove the unused TEST-SUB-E2E");
const put5 = await api("PUT", `/api/categories/${massages.id}`, {
  name: massages.name,
  description: massages.description ?? "",
  isActive: massages.is_active !== false,
  subCategories: after1.filter((s) => s.name !== "TEST-SUB-E2E").map((s) => ({ id: s.id, name: s.name })),
}, token);
check("cleanup PUT returns 200", put5.status === 200, `got ${put5.status}`);
const gone = (
  await pool.query(`SELECT COUNT(*) AS c FROM sub_categories WHERE name = ?`, ["TEST-SUB-E2E"]))
  .flat()[0];
check("TEST-SUB-E2E removed from DB", Number(gone?.c) === 0);

// ---- TEST 6: public API reflects state ----
console.log("\nTEST 6 — public GET /api/categories consistent");
const finalCats = (await api("GET", "/api/categories")).payload?.data?.categories ?? [];
const finalMassages = finalCats.find((c) => c.slug === "head-massages");
check("public categories still consistent", JSON.stringify(finalMassages.subcategories.map((s) => Number(s.id)).sort()) === JSON.stringify(beforeSubIds));

console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
