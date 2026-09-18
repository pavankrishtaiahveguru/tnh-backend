import pg from "pg";
import dotenv from "dotenv";
import { AsyncLocalStorage } from "node:async_hooks";

dotenv.config();

// ---- Per-request query instrumentation (development observability) ----
// Lets controllers wrap a request body in runWithQueryContext() and read back
// how many SQL queries ran and how much DB time they took — without threading
// a stats object through every model call. No-op outside that wrapper.
const queryContext = new AsyncLocalStorage();

export function runWithQueryContext(fn) {
  return queryContext.run({ count: 0, timeMs: 0 }, async () => {
    const result = await fn();
    // Snapshot the stats INSIDE the context — the store is unreadable after
    // run() exits, so callers get { result, stats } back.
    const store = queryContext.getStore();
    return { result, stats: { count: store.count, timeMs: store.timeMs } };
  });
}

export function getQueryStats() {
  return queryContext.getStore() ?? null;
}

async function withQueryTiming(run) {
  const stats = queryContext.getStore();
  if (!stats) return run();
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    stats.count += 1;
    stats.timeMs += performance.now() - startedAt;
  }
}

const { Pool, types } = pg;

// mysql2 was configured with `dateStrings: true` so TIMESTAMP columns came
// back as plain strings instead of JS Date objects. Register the same
// behavior for pg's "timestamp" OID so the rest of the app (JSON responses,
// existing frontend expectations) sees no change from the driver swap.
types.setTypeParser(1114, (value) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// Converts MySQL-style `?` positional placeholders (used throughout the
// existing raw-SQL model layer) into Postgres `$1, $2, ...` placeholders.
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Mimics mysql2's `[rows, fields]` result shape, including `insertId` /
// `affectedRows` on the first element, so existing call sites written
// against mysql2 (`const [rows] = ...` / `const [result] = ...`) keep
// working unchanged. `insertId` requires the query to include `RETURNING id`.
function adapt(pgResult) {
  // A multi-statement simple-query call (e.g. the schema migration script)
  // resolves with an array of per-statement results instead of one — take
  // the last statement's result, mirroring what callers care about.
  const result = Array.isArray(pgResult)
    ? pgResult[pgResult.length - 1]
    : pgResult;
  const rows = result.rows ?? [];
  Object.defineProperty(rows, "insertId", {
    value: rows[0]?.id,
    enumerable: false,
  });
  Object.defineProperty(rows, "affectedRows", {
    value: result.rowCount,
    enumerable: false,
  });
  return [rows, undefined];
}

// `params === undefined` (call sites that pass no second argument) is kept
// on Postgres's simple query protocol, which allows multiple semicolon
// separated statements — needed by the schema migration script. Any call
// that passes an (even empty) array switches to the parameterized protocol,
// matching how every other query in this codebase is written.
async function query(sql, params) {
  const text = toPgQuery(sql);
  return withQueryTiming(() =>
    params === undefined
      ? pool.query(text).then(adapt)
      : pool.query(text, params).then(adapt),
  );
}

async function getConnection() {
  const client = await pool.connect();
  return {
    query: async (sql, params) => {
      const text = toPgQuery(sql);
      return withQueryTiming(() =>
        params === undefined
          ? client.query(text).then(adapt)
          : client.query(text, params).then(adapt),
      );
    },
    beginTransaction: () => client.query("BEGIN"),
    commit: () => client.query("COMMIT"),
    rollback: () => client.query("ROLLBACK"),
    release: () => client.release(),
  };
}

const db = { query, getConnection, end: () => pool.end() };

export async function testConnection() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

export default db;
