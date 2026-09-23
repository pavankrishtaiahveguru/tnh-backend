// E2E TEST — Admin-created service appears on the PUBLIC Services page flow.
// Mirrors the exact requests the public /services page makes:
//   1. GET /api/services?limit=24&branch=both&status=Active&page=1   (initial)
//   2. + &category=bleach-d-tan                                      (category chip)
//   3. + &subCategory=Face                                           (subcategory chip)
//   4. Facet counts request (subcategory chips)
// and verifies a service created via the ADMIN payload shape
// (POST /api/services with subCategoryId=slug, isActive=true, branchIds)
// shows up in every one of those responses — plus the View More path and
// the page-2 boundary (pagination must never hide it either way).
//
// Usage:
//   TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=... node scripts/testPublicServiceVisibility.mjs
import dotenv from "dotenv";
dotenv.config();

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.TEST_PORT ?? "5003";
const BASE = `http://localhost:${PORT}`;
const EMAIL = process.env.TEST_ADMIN_EMAIL ?? "thenailhue@gmail.com";
const PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "";
if (!PASSWORD) {
  console.error("TEST_ADMIN_PASSWORD is required");
  process.exit(1);
}

const CATEGORY_SLUG = "bleach-d-tan";
const SUB_NAME = "Face";
const SERVICE_NAME = "Test Public Service";

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

// Extract service names/ids from either response shape (paginated or legacy).
function serviceRows(payload) {
  return payload?.data?.services ?? payload?.services ?? [];
}

let server = null;
try {
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    if (process.env.TEST_VERBOSE) process.stdout.write(`  [server] ${chunk}`);
  });
  server.stderr.on("data", (chunk) => process.stderr.write(`  [server] ${chunk}`));

  check("server started + healthy", await waitForServer());

  const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  token = login.payload?.token;
  check("admin login", login.status === 200 && Boolean(token));

  // ---- STEP A/B: create the service via the ADMIN payload (same shape the
  // Admin form sends after the subCategoryId fix) and verify the DB row ----
  console.log("\nSTEP A-B — admin create + DB row");
  const branches = (await api("GET", "/api/branches")).payload?.data?.branches ?? [];
  const branchIds = branches.map((b) => b.slug);
  const post = await api("POST", "/api/services", {
    name: SERVICE_NAME,
    categoryId: CATEGORY_SLUG,
    subCategoryId: SUB_NAME,
    audience: "Unisex",
    pricingType: "fixed",
    price: 500,
    duration: "30 min",
    branchIds,
    isActive: true,
  });
  check("POST /api/services returns 201", post.status === 201, JSON.stringify(post.payload ?? {}).slice(0, 250));
  const createdId = Number(post.payload?.data?.service?.id);

  const [dbRow] = (
    await pool.query(
      `SELECT s.id, s.name, s.category_id, s.sub_category_id, s.is_active, s.display_order,
              c.name AS category_name, sc.name AS subcategory_name
       FROM services s
       LEFT JOIN categories c ON c.id = s.category_id
       LEFT JOIN sub_categories sc ON sc.id = s.sub_category_id
       WHERE s.id = ?`,
      [createdId],
    )
  )[0];
  check("DB row exists", Boolean(dbRow));
  check("category_id correct (Bleach & D-Tan)", Number(dbRow?.category_id) === 7, JSON.stringify(dbRow));
  check("sub_category_id correct (Face)", dbRow?.subcategory_name === SUB_NAME, JSON.stringify(dbRow));
  check("is_active = true (public status filter satisfied)", dbRow?.is_active === true, String(dbRow?.is_active));
  const [branchRows] = (
    await pool.query(`SELECT COUNT(*) AS c FROM service_branches WHERE service_id = ?`, [createdId])
  )[0];
  check("branch mappings created", Number(branchRows?.c ?? 0) > 0, `count=${branchRows?.c}`);

  // ---- STEP C: EXACT public page request — initial load (page 1) ----
  // Mirrors getServicesPage({ status:'Active', branch:'both', page:1, limit:24 })
  console.log("\nSTEP C — public page 1 request (initial load)");
  const page1 = await api(
    "GET",
    `/api/services?limit=24&branch=both&status=Active&page=1`,
  );
  const p1 = serviceRows(page1.payload);
  check("page 1 returns 200 + 24 rows", page1.status === 200 && p1.length === 24, `rows=${p1.length}`);
  const onP1 = p1.some((s) => Number(s.id) === createdId);
  check(
    "new service IS on page 1 (display_order=0 sorts first)",
    onP1,
    onP1 ? "" : `first row: ${p1[0]?.name}`,
  );
  check("pagination metadata present", Boolean(page1.payload?.pagination));

  // ---- STEP D: category filter request ----
  console.log("\nSTEP D — public category filter (?category=bleach-d-tan)");
  const catPage = await api(
    "GET",
    `/api/services?limit=24&branch=both&status=Active&page=1&category=${CATEGORY_SLUG}`,
  );
  const catRows = serviceRows(catPage.payload);
  check("category-filtered request returns the service", catRows.some((s) => Number(s.id) === createdId), `rows=${catRows.length}`);
  const facets = catPage.payload?.subCategories;
  check(
    "facet chips include Face (subcategory chips server-side)",
    Array.isArray(facets) && facets.some((f) => f.name === SUB_NAME),
    JSON.stringify(facets)?.slice(0, 200),
  );

  // ---- STEP E: subcategory filter request ----
  console.log("\nSTEP E — public subcategory filter (?subCategory=Face)");
  const subPage = await api(
    "GET",
    `/api/services?limit=24&branch=both&status=Active&page=1&category=${CATEGORY_SLUG}&subCategory=${encodeURIComponent(SUB_NAME)}`,
  );
  const subRows = serviceRows(subPage.payload);
  check("subcategory-filtered request returns the service", subRows.some((s) => Number(s.id) === createdId), `rows=${subRows.length}`);

  // ---- STEP F: ordering sanity — new services must never be hidden by the
  // default sort on page 1 (display_order ASC). Assert the new row's
  // position is within the first page for the exact catalog state. ----
  console.log("\nSTEP F — ordering/pagination boundary check");
  const [orderRow] = (
    await pool.query(
      `SELECT position FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY display_order ASC, name ASC, id ASC) AS position
         FROM services WHERE is_active = TRUE
       ) ranked WHERE id = ?`,
      [createdId],
    )
  )[0];
  const position = Number(orderRow?.position ?? 0);
  check(
    "service position within page 1 of the public order (<= 24)",
    position >= 1 && position <= 24,
    `position=${position}`,
  );

  // ---- STEP G: View More path — page 2 request also works (pagination intact) ----
  console.log("\nSTEP G — page 2 (View More) request shape");
  const page2 = await api(
    "GET",
    `/api/services?limit=24&branch=both&status=Active&page=2`,
  );
  check("page 2 returns 200 with rows", page2.status === 200 && serviceRows(page2.payload).length > 0, `status=${page2.status}`);

  // ---- STEP H: legacy full-list path (used by getAllActiveServices/booking) ----
  console.log("\nSTEP H — legacy full-list (?status=Active) includes the service");
  const legacy = await api("GET", `/api/services?status=Active`);
  check("legacy list includes the service", serviceRows(legacy.payload).some((s) => Number(s.id) === createdId));

  // ---- Cleanup: delete ONLY the test service ----
  console.log("\nCleanup — removing the test service");
  const del = await api("DELETE", `/api/services/${createdId}`);
  check("test service deleted", del.status === 200, `got ${del.status}`);
  const [left] = (await pool.query(`SELECT COUNT(*) AS c FROM services WHERE id = ?`, [createdId]))[0];
  check("no test service remains", Number(left?.c ?? 0) === 0);

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
} catch (error) {
  console.error("UNEXPECTED ERROR:", error);
  failed += 1;
} finally {
  if (server && process.env.TEST_KEEP_SERVER !== "1") server.kill();
  await pool.end().catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}
