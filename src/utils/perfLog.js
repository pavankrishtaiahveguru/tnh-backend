// ==================================================
// Development-only API timing log
// ==================================================
// Phase 2 instrumentation. Emits a compact summary per request — total HTTP
// time, DB query count and DB time — ONLY when NODE_ENV !== "production", so
// no noisy or sensitive output reaches production logs.
//
// DISABLED for normal development/runtime (the verbose [Services API] block
// flooded the terminal). Measurement code is preserved; re-enable the
// console.log below only when debugging timings, via:
//   LOG_API_TIMING=1 node src/server.js
export function logApiTiming(
  label,
  { startedAt, method, url, rowCount },
  stats = null,
) {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.LOG_API_TIMING !== "1") return;

  const totalMs = performance.now() - startedAt;
  const dbTime = stats ? Math.round(stats.timeMs) : null;
  const dbQueries = stats ? stats.count : null;
  const overhead = dbTime != null ? Math.max(0, Math.round(totalMs) - dbTime) : null;

  const lines = [
    `[${label}]`,
    `Request: ${method} ${url}`,
    dbQueries != null ? `DB queries: ${dbQueries}` : null,
    dbTime != null ? `DB time: ${dbTime}ms` : null,
    overhead != null ? `Serialization/overhead: ${overhead}ms` : null,
    `Total API time: ${Math.round(totalMs)}ms`,
    rowCount != null ? `Rows: ${rowCount}` : null,
  ].filter(Boolean);

  // Verbose performance/debug output — disabled for normal development.
  // Uncomment (or run with LOG_API_TIMING=1) to see the [Services API] block:
  // console.log(lines.join("\n"));
}
