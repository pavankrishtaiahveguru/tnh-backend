// E2E TEST — Bleach & D-Tan "Face" subcategory → Add Service mapping flow.
// Reproduces the exact admin scenario: add subcategory to a category via PUT,
// verify DB persistence + ID preservation, then create a service referencing
// it, verify the DB relationship, cross-category rejection, public API
// visibility, and clean up the test service (keeps the "Face" subcategory,
// matching the requested end state).
//
// Usage:
//   TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... node scripts/testBleachDTanFlow.mjs
//   (set TEST_KEEP_SERVER=1 to keep the spawned server running afterwards)
import dotenv from "dotenv";
dotenv.config();

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.TEST_PORT ?? "5002";
const BASE = `http://localhost:${PORT}`;
const EMAIL = process.env.TEST_ADMIN_EMAIL ?? "thenailhue@gmail.com";
const PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "";
if (!PASSWORD) {
  console.error("TEST_ADMIN_PASSWORD is required");
  process.exit(1);
}

const CATEGORY_SLUG = process.env.TEST_CATEGORY_SLUG ?? "bleach-d-tan";
const SUB_NAME = process.env.TEST_SUB_NAME ?? "Face";
const SERVICE_NAME = "Test Face Service";

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// Tiny fetch wrapper (login + admin auth header + JSON parsing).
let token = null;
async function api(method, path, body) {
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

// Direct DB access for the persistence checks (uses the backend's .env).
const { default: pool } = await import("../src/config/database.js");

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {}
    await delay(500);
  }
  return false;
}

let server = null;
try {
  // ---- Boot an isolated server instance on the test port ----
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    if (process.env.TEST_VERBOSE) process.stdout.write(`  [server] ${chunk}`);
  });
  server.stderr.on("data", (chunk) => process.stderr.write(`  [server] ${chunk}`));

  check("server started + healthy", await waitForServer(), "server did not become healthy in time");

  // ---- Login ----
  const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  token = login.payload?.token;
  check("admin login", login.status === 200 && Boolean(token), JSON.stringify(login.payload ?? {}).slice(0, 200));

  // ---- Capture "before" state of the target category ----
  const catsRes = await api("GET", "/api/categories");
  const cats = catsRes.payload?.data?.categories ?? [];
  const category = cats.find((c) => c.slug === CATEGORY_SLUG);
  check(`found category "${CATEGORY_SLUG}"`, Boolean(category));
  const beforeSubIds = (category?.subcategories ?? []).map((s) => Number(s.id)).sort((a, b) => a - b);
  console.log(`  (before: ${(category?.subcategories ?? []).map((s) => s.name).join(", ")})`);

  // ---- STEP 3/4: add the "Face" subcategory via PUT (the exact admin flow) ----
  console.log(`\nSTEP 3-4 — add "${SUB_NAME}" subcategory via PUT /api/categories/:id`);
  const subAlreadyExists = (category?.subcategories ?? []).some(
    (s) => s.name.toLowerCase() === SUB_NAME.toLowerCase(),
  );
  const updatedSubs = subAlreadyExists
    ? (category.subcategories ?? []).map((s) => ({ id: s.id, name: s.name }))
    : [...(category?.subcategories ?? []).map((s) => ({ id: s.id, name: s.name })), { name: SUB_NAME }];
  const put1 = await api("PUT", `/api/categories/${category.id}`, {
    name: category.name,
    description: category.description ?? "",
    isActive: category.is_active !== false,
    subCategories: updatedSubs,
  });
  check("PUT returns 200", put1.status === 200, JSON.stringify(put1.payload ?? {}).slice(0, 200));
  const after1 = put1.payload?.data?.category?.subcategories ?? [];
  const newSub = after1.find((s) => s.name.toLowerCase() === SUB_NAME.toLowerCase());
  check(`"${SUB_NAME}" present in API response`, Boolean(newSub));

  // ---- STEP 5: verify persistence + ID preservation ----
  console.log("\nSTEP 5 — DB persistence + ID preservation");
  const dbNewSub = (
    await pool.query(
      `SELECT id, category_id, slug, name FROM sub_categories WHERE category_id = ? AND LOWER(name) = ?`,
      [category.id, SUB_NAME.toLowerCase()],
    )
  )[0][0];
  check("DB row created", Boolean(dbNewSub));
  check("DB category_id correct", Boolean(dbNewSub) && Number(dbNewSub.category_id) === Number(category.id));
  // The pre-existing set = everything except a sub THIS RUN created. On a
  // re-run (Face already kept from a previous run) nothing new is inserted,
  // so the full before/after ID sets must match exactly — proving no
  // delete/recreate happened.
  const afterSubIds = subAlreadyExists
    ? after1.map((s) => Number(s.id)).sort((a, b) => a - b)
    : after1
        .filter((s) => s.name.toLowerCase() !== SUB_NAME.toLowerCase())
        .map((s) => Number(s.id))
        .sort((a, b) => a - b);
  check(
    "existing subcategory IDs unchanged (no delete/recreate)",
    JSON.stringify(beforeSubIds) === JSON.stringify(afterSubIds),
    `${JSON.stringify(beforeSubIds)} vs ${JSON.stringify(afterSubIds)}`,
  );
  // Services mapped to the pre-existing subs must keep their mapping.
  const linkedBefore = (
    await pool.query(
      `SELECT COUNT(*) AS c FROM services WHERE sub_category_id = ANY($1::int[])`,
      [beforeSubIds.length ? beforeSubIds : [-1]],
    )
  )[0][0];
  check(
    "existing services still mapped to their subcategories",
    Number(linkedBefore?.c ?? 0) > 0 || beforeSubIds.length === 0,
    `count=${linkedBefore?.c}`,
  );

  // ---- STEP 6-10: create the service with the new subcategory ----
  console.log(`\nSTEP 6-10 — create "${SERVICE_NAME}" with subCategoryId`);
  const branches = (await api("GET", "/api/branches")).payload?.data?.branches ?? [];
  const branchIds = (branches.length ? branches : [{ slug: "indiranagar" }]).map((b) => b.slug);
  const post1 = await api("POST", "/api/services", {
    name: SERVICE_NAME,
    categoryId: category.slug,
    subCategoryId: newSub.name,
    audience: "Unisex",
    pricingType: "fixed",
    price: 499,
    duration: "30 min",
    branchIds,
    isActive: true,
  });
  check("POST /api/services returns 201", post1.status === 201, JSON.stringify(post1.payload ?? {}).slice(0, 250));
  const created = post1.payload?.data?.service;
  const createdId = Number(created?.id);
  check("service response includes subcategory name", created?.subcategory_name === SUB_NAME, JSON.stringify(created?.subcategory_name));

  // ---- STEP 11: verify the DB relationship ----
  console.log("\nSTEP 11 — DB relationship verification");
  const dbSvc = (
    await pool.query(
      `SELECT s.id, s.name, s.category_id, s.sub_category_id,
              c.name AS category_name, sc.name AS subcategory_name
       FROM services s
       LEFT JOIN categories c ON c.id = s.category_id
       LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
       WHERE s.id = ?`,
      [createdId],
    )
  )[0][0];
  check("service row exists", Boolean(dbSvc));
  check(
    "service category_id = category id",
    Number(dbSvc?.category_id) === Number(category.id),
    `${dbSvc?.category_id} vs ${category.id}`,
  );
  check(
    "service sub_category_id = new subcategory id",
    Boolean(dbSvc) && Number(dbSvc.sub_category_id) === Number(dbNewSub.id),
    `db sub=${dbSvc?.sub_category_id} vs new sub=${dbNewSub?.id}`,
  );
  check("subcategory_name joined = Face", dbSvc?.subcategory_name === SUB_NAME, dbSvc?.subcategory_name);
  check(
    "services.category_id = sub_categories.category_id invariant",
    Number(dbSvc?.category_id) === Number(dbNewSub.category_id),
  );

  // ---- Cross-category subCategoryId must be rejected (HTTP 400) ----
  console.log("\nValidation — cross-category subCategoryId rejected");
  const otherCat = cats.find((c) => c.slug !== CATEGORY_SLUG && (c.subcategories ?? []).length > 0);
  const post2 = await api("POST", "/api/services", {
    name: "INVALID TEST SERVICE",
    categoryId: category.slug,
    subCategoryId: Number(otherCat.subcategories[0].id),
    audience: "Unisex",
    pricingType: "fixed",
    price: 100,
    branchIds,
  });
  check("cross-category subCategoryId (numeric) → 400", post2.status === 400, `got ${post2.status} ${JSON.stringify(post2.payload ?? {}).slice(0, 150)}`);
  const invalidExists = (
    await pool.query(`SELECT COUNT(*) AS c FROM services WHERE name = ?`, ["INVALID TEST SERVICE"])
  )[0][0];
  check("invalid service NOT persisted", Number(invalidExists?.c ?? 0) === 0);

  // Cross-category SLUG must also be rejected — this is the exact payload
  // shape the admin frontend sends (subCategoryId = sub's slug).
  const otherCatSub = otherCat.subcategories[0];
  const post4 = await api("POST", "/api/services", {
    name: "INVALID TEST SERVICE",
    categoryId: category.slug,
    subCategoryId: otherCatSub.slug,
    audience: "Unisex",
    pricingType: "fixed",
    price: 100,
    branchIds,
  });
  check("cross-category subCategoryId (slug) → 400", post4.status === 400, `got ${post4.status}`);

  // ---- SLUG-based resolution (the new frontend payload shape) ----
  // Resolve by slug and verify the exact row: under Nails there are two subs
  // with the display name "Removal & Refills" (ids 111 & 185) — a name-based
  // match could bind to the wrong one; a slug match must hit id 111 exactly.
  console.log("\nValidation — slug-based subCategoryId resolves to the exact row");
  const [nailsCat] = cats.filter((c) => c.slug === "nails");
  const [targetSubRow] = (
    await pool.query(
      `SELECT id, slug, name FROM sub_categories WHERE category_id = ? AND slug = ?`,
      [nailsCat.id, "removal-refills"],
    )
  )[0];
  if (targetSubRow) {
    const post5 = await api("POST", "/api/services", {
      name: "TEST SLUG RESOLUTION SERVICE",
      categoryId: "nails",
      subCategoryId: "removal-refills",
      audience: "Unisex",
      pricingType: "fixed",
      price: 100,
      branchIds,
    });
    const slugSvcId = Number(post5.payload?.data?.service?.id);
    check("slug-based creation returns 201", post5.status === 201, `got ${post5.status}`);
    const [slugRow] = (
      await pool.query(`SELECT sub_category_id FROM services WHERE id = ?`, [slugSvcId])
    )[0];
    check(
      "slug resolved to the exact sub_categories row (id match)",
      Number(slugRow?.sub_category_id) === Number(targetSubRow.id),
      `db sub=${slugRow?.sub_category_id} expected=${targetSubRow.id}`,
    );
    const del5 = await api("DELETE", `/api/services/${slugSvcId}`);
    check("slug-resolution test service deleted", del5.status === 200, `got ${del5.status}`);
  } else {
    console.log("  (skipped — nails/removal-refills sub not present in this environment)");
  }

  // ---- Service with NULL subcategory allowed (optional field) ----
  console.log("\nValidation — service without subcategory still allowed");
  const post3 = await api("POST", "/api/services", {
    name: "TEST NO-SUB SERVICE",
    categoryId: category.slug,
    audience: "Unisex",
    pricingType: "fixed",
    price: 100,
    branchIds,
  });
  const noSub = post3.payload?.data?.service;
  check("no-sub service created (sub optional)", post3.status === 201, `got ${post3.status}`);
  const noSubId = Number(noSub?.id);

  // ---- STEP 12: admin service list shows category + subcategory ----
  console.log("\nSTEP 12 — service appears with category/subcategory mapping");
  const svcList = (await api("GET", "/api/services?category=" + CATEGORY_SLUG)).payload?.data?.services ?? [];
  const listed = svcList.find((s) => Number(s.id) === createdId);
  check("service in admin list", Boolean(listed));
  check("list row carries subcategory_name", listed?.subcategory_name === SUB_NAME, listed?.subcategory_name);

  // ---- STEP 13: public API reflects the mapping ----
  console.log("\nSTEP 13 — public API reflects the new subcategory");
  const pub = (
    await api("GET", `/api/services?category=${CATEGORY_SLUG}&subCategory=${encodeURIComponent(SUB_NAME)}&status=Active`)
  ).payload?.data?.services ?? [];
  check("public API returns the service under the new subcategory", pub.some((s) => Number(s.id) === createdId));

  // ---- Cleanup: remove test services; keep "Face" (matches the scenario's expected end state) ----
  console.log("\nCleanup — removing test services (Face subcategory kept)");
  if (createdId) {
    const del1 = await api("DELETE", `/api/services/${createdId}`);
    check("test service deleted", del1.status === 200, `got ${del1.status}`);
  }
  if (noSubId) {
    const del2 = await api("DELETE", `/api/services/${noSubId}`);
    check("no-sub test service deleted", del2.status === 200, `got ${del2.status}`);
  }
  const left = (
    await pool.query(`SELECT COUNT(*) AS c FROM services WHERE name IN (?, ?)`, [SERVICE_NAME, "TEST NO-SUB SERVICE"])
  )[0][0];
  check("no test services remain", Number(left?.c ?? 0) === 0);
  const faceStill = (
    await pool.query(`SELECT COUNT(*) AS c FROM sub_categories WHERE id = ?`, [dbNewSub.id])
  )[0][0];
  check(`"${SUB_NAME}" subcategory still present (kept)`, Number(faceStill?.c ?? 0) === 1);

  // ---- Final: public categories still consistent ----
  const finalCats = (await api("GET", "/api/categories")).payload?.data?.categories ?? [];
  const finalCat = finalCats.find((c) => c.slug === CATEGORY_SLUG);
  const finalOriginalIds = subAlreadyExists
    ? (finalCat?.subcategories ?? []).map((s) => Number(s.id)).sort((a, b) => a - b)
    : (finalCat?.subcategories ?? [])
        .filter((s) => s.name.toLowerCase() !== SUB_NAME.toLowerCase())
        .map((s) => Number(s.id))
        .sort((a, b) => a - b);
  check(
    "final public state: original sub IDs preserved + Face present",
    JSON.stringify(finalOriginalIds) === JSON.stringify(beforeSubIds) &&
      (finalCat?.subcategories ?? []).some((s) => s.name.toLowerCase() === SUB_NAME.toLowerCase()),
    JSON.stringify(finalCat?.subcategories ?? []),
  );

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
} catch (error) {
  console.error("UNEXPECTED ERROR:", error);
  failed += 1;
} finally {
  if (server) {
    if (process.env.TEST_KEEP_SERVER !== "1") server.kill();
  }
  await pool.end().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}
