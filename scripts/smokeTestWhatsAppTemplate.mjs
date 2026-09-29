// Smoke test for the shared WhatsApp booking message template (bookingCore.js).
// Run: node tnh-backend/scripts/smokeTestWhatsAppTemplate.mjs
import { buildWhatsAppMessage, getBranchWhatsAppNumber } from "../../tnh-salon/src/components/services/bookingCore.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    if (detail) console.log(detail);
  }
}

// --- Fixture: plain service, no variants (TEST 1) ---
const haircut = { service: { id: "s1", name: "Haircut", branch: "both branches", variants: [], price: 499 }, selectedVariantId: null };
// --- Fixture: variant selected (TEST 2) ---
const oil = { service: { id: "s2", name: "Head Massage-Oil", branch: "both branches", price: null, variants: [{ id: "v-s", label: "S", price: 500 }, { id: "v-m", label: "M", price: 900 }] }, selectedVariantId: "v-s" };
// --- Fixture: different variant + bigger price (TEST 3) ---
const keratin = { service: { id: "s3", name: "Keratin Treatment", branch: "both branches", price: null, variants: [{ id: "v-m", label: "M", price: 2997 }] }, selectedVariantId: "v-m" };

const base = { studioName: "Sarjapur Road", customerName: "ro", phone: "9177185103", date: "2026-10-08", selectedTime: "10:30 AM" };

// TEST 1 — one service without variant
const m1 = buildWhatsAppMessage({ ...base, selectedServices: [haircut] });
console.log("TEST 1 — one service, no variant:\n" + m1 + "\n");
check("has single numbered service line", m1.includes("1. Haircut — ₹499"));
check("no per-line tax suffix", !m1.includes("taxes additional"));

// TEST 2 — one service with variant
const m2 = buildWhatsAppMessage({ ...base, selectedServices: [oil] });
console.log("TEST 2 — one service with variant:\n" + m2 + "\n");
check("variant line format", m2.includes("1. Head Massage-Oil — S — ₹500"));

// TEST 3 — multiple services, different variants, each on its own line
const m3 = buildWhatsAppMessage({ ...base, selectedServices: [haircut, oil, keratin] });
console.log("TEST 3 — multiple services:\n" + m3 + "\n");
check("line 1", m3.includes("1. Haircut — ₹499"));
check("line 2", m3.includes("2. Head Massage-Oil — S — ₹500"));
// formatPrice uses en-IN grouping (shared with the Services cards/modal) — ₹2,997 is correct.
check("line 3", m3.includes("3. Keratin Treatment — M — ₹2,997"));

// TEST 4+5 — exactly one GST line (shared builder → both flows identical)
for (const m of [m1, m2, m3]) {
  const matches = m.match(/\+ 5% GST applicable on all services\./g) ?? [];
  check("exactly one GST line", matches.length === 1, `found ${matches.length}`);
}

// TEST 7 — GST is the LAST content, preceded by a blank line
for (const [name, m] of [["m1", m1], ["m2", m2], ["m3", m3]]) {
  const lines = m.split("\n");
  const last = lines[lines.length - 1];
  check(`GST is last content (${name})`, last === "+ 5% GST applicable on all services.", `last line: "${last}"`);
  check(`blank line before GST (${name})`, lines[lines.length - 2] === "", `line before GST: "${lines[lines.length - 2]}"`);
  check(`follows Thank you (${name})`, m.includes("Please confirm my booking. Thank you!\n\n+ 5% GST applicable on all services."));
}

// TEST 6 — branch routing unchanged (per-branch numbers, 10-digit stored)
check("Sarjapur Road → 9740355663", getBranchWhatsAppNumber("sarjapur-road") === "9740355663");
check("Sarjapura Road (name variant) → 9740355663", getBranchWhatsAppNumber("Sarjapura Road") === "9740355663");
check("Indiranagar → 9177185103", getBranchWhatsAppNumber("indiranagar") === "9177185103");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
