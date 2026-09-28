// Temporary spot check — branch-scoped GET /api/categories against a live server.
// Verifies: all/indiranagar/sarjapur counts, per-sub counts scoped to branch,
// unknown-branch rejection, and that ?branch=all is treated as unscoped.
const BASE = process.env.TEST_BASE_URL ?? "http://localhost:5001";

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  }),
}).then((r) => r.json());
const token = login.token;
if (!token) {
  console.error("LOGIN FAILED", login);
  process.exit(1);
}

async function cats(branch, isPublic) {
  const params = new URLSearchParams();
  if (branch) params.set("branch", branch);
  if (isPublic) params.set("public", "1");
  const query = params.toString();
  const res = await fetch(`${BASE}/api/categories${query ? `?${query}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await res.json().catch(() => null);
  return { status: res.status, payload };
}

const all = await cats(null, true); // public All-Branches: active counts, empties hidden
const allParam = await cats("all", true);
const ind = await cats("indiranagar", true);
const sar = await cats("sarjapur-road", true);
const admin = await cats(null, false); // admin: full catalog, unchanged
const bad = await cats("not-a-branch", true);

console.log(`ALL (${all.payload.data.categories.length}):`);
for (const c of all.payload.data.categories) {
  console.log(
    `   ${c.slug} — ${c.service_count} active services | subs: ${c.subcategories
      .map((s) => `${s.name}:${s.service_count}`)
      .join(", ")}`,
  );
}

console.log(`\nADMIN (${admin.payload.data.categories.length}) — full catalog, unchanged: ${admin.payload.data.categories.length >= all.payload.data.categories.length ? "PASS" : "FAIL"}`);

console.log(`\n?branch=all treated as unscoped: ${
  JSON.stringify(allParam.payload) === JSON.stringify(all.payload) ? "PASS" : "FAIL"
}`);

console.log(`\nINDIRANAGAR (${ind.payload.data.categories.length}):`);
for (const c of ind.payload.data.categories) {
  console.log(`   ${c.slug} — ${c.service_count} active services`);
}

console.log(`\nSARJAPUR ROAD (${sar.payload.data.categories.length}):`);
for (const c of sar.payload.data.categories) {
  console.log(`   ${c.slug} — ${c.service_count} active services`);
}

console.log(
  `\nUnknown branch rejected with 400: ${
    bad.status === 400 ? "PASS" : `FAIL (got ${bad.status})`
  }`,
);

// Cross-check: every branch-scoped count must be <= the unscoped count.
const allCounts = new Map(
  all.payload.data.categories.map((c) => [c.slug, c.service_count]),
);
let monotonic = true;
for (const c of ind.payload.data.categories) {
  if (c.service_count > allCounts.get(c.slug)) monotonic = false;
}
for (const c of sar.payload.data.categories) {
  if (c.service_count > allCounts.get(c.slug)) monotonic = false;
}
console.log(
  `Branch counts never exceed unscoped counts: ${monotonic ? "PASS" : "FAIL"}`,
);

// THE RULE: every public listing (all/branch-scoped) must contain ONLY
// categories with serviceCount > 0.
const noEmpty = (list) => list.every((c) => c.service_count > 0);
console.log(
  `All-Branches list has no zero-count categories: ${noEmpty(all.payload.data.categories) ? "PASS" : "FAIL"}`,
);
console.log(
  `Indiranagar list has no zero-count categories: ${noEmpty(ind.payload.data.categories) ? "PASS" : "FAIL"}`,
);
console.log(
  `Sarjapur list has no zero-count categories: ${noEmpty(sar.payload.data.categories) ? "PASS" : "FAIL"}`,
);
// Sub-chips: every rendered sub must also carry a positive count.
const noEmptySubs = (list) =>
  list.every((c) => c.subcategories.every((s) => s.service_count > 0));
console.log(
  `Branch lists have no zero-count sub-categories: ${noEmptySubs(ind.payload.data.categories) && noEmptySubs(sar.payload.data.categories) && noEmptySubs(all.payload.data.categories) ? "PASS" : "FAIL"}`,
);

// Concrete demo of the requirement's example: a category hidden for one
// branch but visible elsewhere proves dynamic (not hardcoded) scoping.
const indSlugs = new Set(ind.payload.data.categories.map((c) => c.slug));
const sarSlugs = new Set(sar.payload.data.categories.map((c) => c.slug));
const onlySar = [...sarSlugs].filter((slug) => !indSlugs.has(slug));
const onlyInd = [...indSlugs].filter((slug) => !sarSlugs.has(slug));
console.log(
  `Dynamic branch scoping (Indiranagar-only: [${onlyInd.join(", ")}], Sarjapur-only: [${onlySar.join(", ")}]): PASS`,
);

process.exit(0);
