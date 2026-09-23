// TEMPORARY E2E TEST — category reorder flow (run against a live local server).
// Exercises: happy path (down/up), edge moves, validation, auth, and direct
// DB persistence verification. Non-destructive: uses the test admin, and every
// order mutation is reverted at the end.
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

async function getDbOrder() {
  const [rows] = await pool.query(
    `SELECT id, name, display_order FROM categories ORDER BY display_order, id`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, o: Number(r.display_order) }));
}

const results = [];
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

// ---- Setup: login ----
console.log("SETUP — admin login");
const login = await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
check("login returns 200 + token", login.status === 200 && Boolean(login.payload?.token), JSON.stringify(login.payload));
const token = login.payload?.token;

// ---- Baseline: normalize DB order to 1..n via two reorders? No — read it. ----
const before = await getDbOrder();
console.log(`\nBASELINE — ${before.length} categories, first: ${before[0]?.name} (order ${before[0]?.o}), second: ${before[1]?.name} (order ${before[1]?.o})`);

// ---- TEST 1: move first category DOWN (happy path) ----
console.log("\nTEST 1 — move first category DOWN");
const first = before[0];
const second = before[1];
const r1 = await api("PATCH", `/api/categories/${first.id}/order`, { direction: "down" }, token);
check("HTTP 200", r1.status === 200, `got ${r1.status} ${JSON.stringify(r1.payload)}`);
check("payload.success === true", r1.payload?.success === true);
check("message present", typeof r1.payload?.message === "string" && r1.payload.message.length > 0);
const after1 = await getDbOrder();
check(
  "DB: first↔second swapped (order persisted)",
  after1[0].id === second.id && after1[1].id === first.id,
  `now first=${after1[0].name}, second=${after1[1].name}`,
);
check(
  "DB: dense 1..n ordering after move",
  after1.every((row, i) => row.o === i + 1),
  JSON.stringify(after1.map((r) => r.o)),
);

// ---- TEST 2: move it back UP (swap back) ----
console.log("\nTEST 2 — move (new) second category UP (revert)");
const r2 = await api("PATCH", `/api/categories/${first.id}/order`, { direction: "up" }, token);
check("HTTP 200", r2.status === 200, `got ${r2.status}`);
const after2 = await getDbOrder();
check("DB: reverted to original order", after2[0].id === first.id && after2[1].id === second.id, JSON.stringify(after2.slice(0, 2).map((r) => r.name)));
check("DB: still dense 1..n", after2.every((row, i) => row.o === i + 1));

// ---- TEST 3: edge moves (first up / last down) → 400, no DB change ----
console.log("\nTEST 3 — edge moves rejected honestly");
const last = before[before.length - 1];
const r3a = await api("PATCH", `/api/categories/${first.id}/order`, { direction: "up" }, token);
check("first category 'up' → HTTP 400", r3a.status === 400, `got ${r3a.status}`);
check("response has success:false + message", r3a.payload?.success === false && typeof r3a.payload?.message === "string");
const r3b = await api("PATCH", `/api/categories/${last.id}/order`, { direction: "down" }, token);
check("last category 'down' → HTTP 400", r3b.status === 400, `got ${r3b.status}`);
const after3 = await getDbOrder();
check("DB unchanged after rejected edge moves", JSON.stringify(after3) === JSON.stringify(after2));

// ---- TEST 4: validation + auth + error cases ----
console.log("\nTEST 4 — validation / auth / error cases");
const r4a = await api("PATCH", `/api/categories/999999/order`, { direction: "down" }, token);
check("non-existent id → 404", r4a.status === 404, `got ${r4a.status}`);
const r4b = await api("PATCH", `/api/categories/${first.id}/order`, { direction: "sideways" }, token);
check("invalid direction → 400", r4b.status === 400, `got ${r4b.status}`);
const r4c = await api("PATCH", `/api/categories/${first.id}/order`, {}, token);
check("missing direction → 400", r4c.status === 400, `got ${r4c.status}`);
const r4d = await api("PATCH", `/api/categories/${first.id}/order`, { direction: "down" });
check("no auth token → 401", r4d.status === 401, `got ${r4d.status}`);
const r4e = await api("PATCH", `/api/categories/${first.id}/order`, { direction: "down" }, "invalid.token.here");
check("invalid token → 401", r4e.status === 401, `got ${r4e.status}`);
const after4 = await getDbOrder();
check("DB unchanged after all error cases", JSON.stringify(after4) === JSON.stringify(after2));

// ---- TEST 5: public GET reflects DB order (what the Services page reads) ----
console.log("\nTEST 5 — public categories endpoint order");
const r5 = await api("GET", "/api/categories");
const pubRows = r5.payload?.data?.categories ?? [];
check("public GET /api/categories → 200 + list", r5.status === 200 && Array.isArray(pubRows) && pubRows.length === before.length);
const pubIds = pubRows.map((c) => c.id);
const dbIds = (await getDbOrder()).map((r) => r.id);
check("public order matches DB (display_order, id)", JSON.stringify(pubIds) === JSON.stringify(dbIds));
check("public rows include display_order", pubRows.every((c) => Number.isFinite(Number(c.display_order))));

// ---- Summary ----
console.log(`\n${"=".repeat(50)}\nRESULTS: ${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed > 0 ? 1 : 0);
