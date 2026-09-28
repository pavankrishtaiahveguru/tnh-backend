// LIVE PROBE — Active/Inactive service status flow (run against a local
// server, then the server is stopped by the caller). Exercises the COMPLETE
// flow the Admin UI uses:
//   1. PATCH /api/services/:id/status   (the quick StatusBadge toggle)
//   2. PUT  /api/services/:id           (the edit form's full payload)
//   3. Public query behaviour (?status=Active excludes Inactive rows)
//   4. DB-level verification of is_active + untouched display_order/
//      category_id/sub_category_id/name (regressions 11 + 12)
//   5. Failure handling: invalid status value -> 400, unknown id -> 404
// Every mutation is reverted at the end so this is non-destructive against
// the shared dev database. Usage:
//   TEST_BASE_URL=http://localhost:5005 TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... node scripts/testServiceStatusE2E.mjs
import dotenv from "dotenv";
dotenv.config();

import pool from "../src/config/database.js";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:5001";
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

const SERVICE_NAME = "ZZ Test Status Probe Service";

try {
  // ---- SETUP: login + create a disposable service via the admin payload ----
  console.log("SETUP — admin login + create disposable test service");
  const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  check("login returns 200 + token", login.status === 200 && Boolean(login.payload?.token), JSON.stringify(login.payload).slice(0, 200));
  const token = login.payload?.token;

  const branches = (await api("GET", "/api/branches")).payload?.data?.branches ?? [];
  const branchIds = branches.map((b) => b.slug);
  const created = await api("POST", "/api/services", {
    name: SERVICE_NAME,
    categoryId: "bleach-d-tan",
    audience: "Unisex",
    pricingType: "fixed",
    price: 499,
    branchIds,
    isActive: true,
  }, token);
  check("create returns 201", created.status === 201, JSON.stringify(created.payload).slice(0, 250));
  const serviceId = Number(created.payload?.data?.service?.id);
  check("service id present", Number.isInteger(serviceId) && serviceId > 0, String(serviceId));
  if (!serviceId) throw new Error("No service id — cannot continue");

  const snapshot = (
    await pool.query(
      `SELECT display_order, category_id, sub_category_id, name, price FROM services WHERE id = ?`,
      [serviceId],
    )
  )[0][0];

  // ---- TEST A: Active -> Inactive via PATCH /:id/status ----
  console.log("\nTEST A — Active -> Inactive (PATCH /:id/status)");
  const patch = await api("PATCH", `/api/services/${serviceId}/status`, { status: "Inactive" }, token);
  check("PATCH returns 200", patch.status === 200, `got ${patch.status} ${JSON.stringify(patch.payload).slice(0, 200)}`);
  check("response row is_active=false", patch.payload?.data?.service?.is_active === false, JSON.stringify(patch.payload?.data?.service?.is_active));
  const [dbRowA] = (await pool.query(`SELECT is_active FROM services WHERE id = ?`, [serviceId]))[0];
  check("DB row persisted is_active=false", dbRowA?.is_active === false, String(dbRowA?.is_active));

  // ---- TEST B: Public behaviour — Inactive excluded from ?status=Active ----
  console.log("\nTEST B — public ?status=Active excludes the Inactive service");
  const pubList = await api("GET", `/api/services?status=Active&limit=50`);
  const pubRows = pubList.payload?.data?.services ?? pubList.payload?.services ?? [];
  check("inactive service NOT in public active list", !pubRows.some((s) => Number(s.id) === serviceId), `rows=${pubRows.length}`);
  const pubFilter = await api("GET", `/api/services?status=Inactive&limit=50`);
  const inactiveRows = pubFilter.payload?.data?.services ?? pubFilter.payload?.services ?? [];
  check("inactive service IS in ?status=Inactive list", inactiveRows.some((s) => Number(s.id) === serviceId));

  // ---- TEST C: Inactive -> Active via PATCH (toggle back) ----
  console.log("\nTEST C — Inactive -> Active (PATCH /:id/status)");
  const patch2 = await api("PATCH", `/api/services/${serviceId}/status`, { status: "Active" }, token);
  check("PATCH returns 200", patch2.status === 200, `got ${patch2.status}`);
  check("response row is_active=true", patch2.payload?.data?.service?.is_active === true);
  const [dbRowC] = (await pool.query(`SELECT is_active FROM services WHERE id = ?`, [serviceId]))[0];
  check("DB row persisted is_active=true", dbRowC?.is_active === true, String(dbRowC?.is_active));

  // ---- TEST D: display_order / category / subcategory untouched ----
  console.log("\nTEST D — status change leaves ordering + mappings untouched");
  const [dbRowD] = (
    await pool.query(
      `SELECT display_order, category_id, sub_category_id, name, price FROM services WHERE id = ?`,
      [serviceId],
    )
  )[0];
  check("display_order unchanged", Number(dbRowD?.display_order) === Number(snapshot.display_order), `${snapshot.display_order} -> ${dbRowD?.display_order}`);
  check("category_id unchanged", Number(dbRowD?.category_id) === Number(snapshot.category_id));
  check("sub_category_id unchanged", (dbRowD?.sub_category_id ?? null) === (snapshot.sub_category_id ?? null));
  check("name unchanged", dbRowD?.name === snapshot.name);
  check("price unchanged", Number(dbRowD?.price) === Number(snapshot.price));

  // ---- TEST E: edit form path — PUT /:id with price-only change keeps status ----
  console.log("\nTEST E — PUT (price-only edit) keeps status and ordering");
  const put = await api(
    "PUT",
    `/api/services/${serviceId}`,
    {
      name: SERVICE_NAME,
      categoryId: "bleach-d-tan",
      subCategoryId: null,
      audience: "Unisex",
      description: "",
      pricingType: "fixed",
      price: 599,
      priceRange: null,
      variants: [],
      duration: "",
      branchIds,
      isActive: false, // the form always sends the status it holds
      image: null,
    },
    token,
  );
  check("PUT returns 200", put.status === 200, `got ${put.status} ${JSON.stringify(put.payload).slice(0, 200)}`);
  const [dbRowE] = (await pool.query(`SELECT is_active, price, display_order, category_id FROM services WHERE id = ?`, [serviceId]))[0];
  check("status now Inactive after form save", dbRowE?.is_active === false, String(dbRowE?.is_active));
  check("price updated to 599", Number(dbRowE?.price) === 599, String(dbRowE?.price));
  check("display_order unchanged by PUT", Number(dbRowE?.display_order) === Number(snapshot.display_order), `${snapshot.display_order} -> ${dbRowE?.display_order}`);
  check("category_id unchanged by PUT", Number(dbRowE?.category_id) === Number(snapshot.category_id));

  // ---- TEST F: two independent services toggle independently ----
  console.log("\nTEST F — two services update independently");
  const second = await api("POST", "/api/services", {
    name: `${SERVICE_NAME} 2`,
    categoryId: "bleach-d-tan",
    audience: "Unisex",
    pricingType: "fixed",
    price: 299,
    branchIds,
    isActive: true,
  }, token);
  const secondId = Number(second.payload?.data?.service?.id);
  check("second test service created", second.status === 201 && Number.isInteger(secondId));
  await api("PATCH", `/api/services/${serviceId}/status`, { status: "Inactive" }, token);
  const [row1] = (await pool.query(`SELECT is_active FROM services WHERE id = ?`, [serviceId]))[0];
  const [row2] = (await pool.query(`SELECT is_active FROM services WHERE id = ?`, [secondId]))[0];
  check("service 1 Inactive", row1?.is_active === false);
  check("service 2 still Active", row2?.is_active === true);
  await api("PATCH", `/api/services/${secondId}/status`, { status: "Inactive" }, token);
  const [row2b] = (await pool.query(`SELECT is_active FROM services WHERE id = ?`, [secondId]))[0];
  check("service 2 toggles independently", row2b?.is_active === false);

  // ---- TEST G: validation + auth failure handling ----
  console.log("\nTEST G — failure handling");
  const badStatus = await api("PATCH", `/api/services/${serviceId}/status`, { status: "active" }, token);
  check("lowercase 'active' rejected with 400", badStatus.status === 400, `got ${badStatus.status}`);
  const [rowG] = (await pool.query(`SELECT is_active FROM services WHERE id = ?`, [serviceId]))[0];
  check("DB unchanged after invalid request", rowG?.is_active === false);
  const unauth = await api("PATCH", `/api/services/${serviceId}/status`, { status: "Active" });
  check("unauthenticated PATCH rejected (401)", unauth.status === 401, `got ${unauth.status}`);
  const [rowG2] = (await pool.query(`SELECT is_active FROM services WHERE id = ?`, [serviceId]))[0];
  check("DB unchanged after 401", rowG2?.is_active === false);
  const notFound = await api("PATCH", `/api/services/99999999/status`, { status: "Active" }, token);
  check("unknown id -> 404", notFound.status === 404, `got ${notFound.status}`);

  // ---- TEST H: public Services page request shapes (old vs new) ----
  // serviceId is Inactive here (end of TEST F) and is branch-mapped, so it
  // reproduces exactly what a deactivated service does on the public page.
  console.log("\nTEST H — public page request shapes (old vs fixed)");
  // OLD (buggy) shape the page used to send — no status param.
  const oldShape = await api("GET", `/api/services?limit=24&branch=both&page=1`);
  const oldRows = oldShape.payload?.data?.services ?? [];
  console.log(`        (old shape returns ${oldRows.length} rows; inactive present: ${oldRows.some((s) => Number(s.id) === serviceId)})`);
  // FIXED shape — status=Active included (matches prefetchFirstServicesPage).
  const newP1 = await api("GET", `/api/services?limit=24&branch=both&status=Active&page=1`);
  const newP1Rows = newP1.payload?.data?.services ?? [];
  check("fixed page-1 shape EXCLUDES the inactive service", newP1.status === 200 && !newP1Rows.some((s) => Number(s.id) === serviceId), `rows=${newP1Rows.length}`);
  const newP2 = await api("GET", `/api/services?limit=24&branch=both&status=Active&page=2`);
  const newP2Rows = newP2.payload?.data?.services ?? [];
  check("fixed View-More (page 2) shape EXCLUDES the inactive service", newP2.status === 200 && !newP2Rows.some((s) => Number(s.id) === serviceId), `rows=${newP2Rows.length}`);
  const anyActive = newP1Rows.length > 0;
  check("fixed shape still returns active services", anyActive, `rows=${newP1Rows.length}`);

  // ---- CLEANUP: remove ONLY the test services ----
  console.log("\nCleanup — removing test services");
  await api("DELETE", `/api/services/${serviceId}`, undefined, token);
  await api("DELETE", `/api/services/${secondId}`, undefined, token);
  const [left1] = (await pool.query(`SELECT COUNT(*)::int AS c FROM services WHERE id = ANY($1)`, [[serviceId, secondId]]))[0];
  check("no test services remain", Number(left1?.c ?? 0) === 0, `count=${left1?.c}`);

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
} catch (error) {
  console.error("UNEXPECTED ERROR:", error);
  failed += 1;
  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
} finally {
  await pool.end().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}
