import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  contentTypeForFile,
  createR2Storage,
} from "../src/services/r2Storage.js";

const { Pool } = pg;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "media-migration-manifest.json",
);
const VALID_TABLES = new Set(["categories", "services"]);
const VALID_FIELDS = new Set(["image", "image_url"]);

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function hasOption(name) {
  return process.argv.includes(name);
}

function isDryRun() {
  return hasOption("--dry-run");
}

function sourceRoots() {
  const roots = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--source-root" && process.argv[i + 1]) {
      roots.push(path.resolve(process.argv[i + 1]));
      i += 1;
    }
  }
  if (roots.length) return roots;
  return [
    path.resolve(PROJECT_ROOT, "../tnh-salon/public"),
    path.resolve(PROJECT_ROOT, "data"),
  ];
}

function safeFilename(url) {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return path.basename(String(url).split(/[?#]/, 1)[0]);
  }
}

function cloudinaryPublicId(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/(?:image|video)\/upload\/(?:v\d+\/)?(.+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function routeForReference(reference) {
  return reference.table === "categories"
    ? ["/services", "/admin/categories"]
    : ["/services", `/admin/services/${reference.recordId}`];
}

async function indexLocalMedia(roots) {
  const byName = new Map();
  const validExtension = /\.(avif|gif|jpe?g|png|webp|m4v|mov|mp4|webm)$/i;

  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (![".git", "node_modules", ".next", "dist", "build"].includes(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile() && validExtension.test(entry.name)) {
        const paths = byName.get(entry.name) ?? [];
        paths.push(fullPath);
        byName.set(entry.name, paths);
      }
    }
  }

  for (const root of roots) await walk(root);
  return byName;
}

async function readLiveReferences(pool) {
  const result = await pool.query(`
    SELECT 'categories' AS table_name, id AS record_id, slug AS record_slug,
           name AS record_name, NULL::text AS category_name,
           'image' AS field_name, image AS source_url
    FROM categories WHERE image ILIKE '%cloudinary%'
    UNION ALL
    SELECT 'categories', id, slug, name, NULL::text, 'image_url', image_url
    FROM categories WHERE image_url ILIKE '%cloudinary%'
    UNION ALL
    SELECT 'services', s.id, s.slug, s.name, c.name,
           'image', s.image
    FROM services s LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.image ILIKE '%cloudinary%'
    UNION ALL
    SELECT 'services', s.id, s.slug, s.name, c.name,
           'image_url', s.image_url
    FROM services s LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.image_url ILIKE '%cloudinary%'
    ORDER BY table_name, record_id, field_name
  `);
  return result.rows;
}

function makeManifestAsset(sourceUrl, references, localIndex) {
  const filename = safeFilename(sourceUrl);
  const candidates = localIndex.get(filename) ?? [];
  const exactMatch = candidates.length === 1 ? candidates[0] : null;
  const assetId = crypto
    .createHash("sha256")
    .update(sourceUrl)
    .digest("hex")
    .slice(0, 24);

  return {
    assetId,
    sourceProvider: "cloudinary",
    sourceUrl,
    cloudinaryPublicId: cloudinaryPublicId(sourceUrl),
    sourceFilename: filename,
    mediaType: /\.(mp4|m4v|mov|webm)$/i.test(filename) ? "video" : "image",
    localSourcePath: exactMatch,
    localSourceCandidates: candidates,
    objectKey: null,
    publicUrl: null,
    sha256: null,
    destinationVerified: false,
    migrationStatus: exactMatch ? "source-available" : "needs-replacement",
    failureReason: exactMatch
      ? null
      : candidates.length === 0
        ? `No exact local source file was found for ${filename}; a replacement file is required.`
        : `Multiple local files have the exact source filename: ${filename}`,
    references: references.map((reference) => ({
      table: reference.table_name,
      recordId: reference.record_id,
      recordSlug: reference.record_slug,
      recordName: reference.record_name,
      categoryName: reference.category_name,
      field: reference.field_name,
      originalUrl: reference.source_url,
      route: routeForReference({
        table: reference.table_name,
        recordId: reference.record_id,
      }),
      databaseUpdated: false,
      updatedUrl: null,
    })),
  };
}

async function writeManifest(manifest) {
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  const temporaryPath = `${MANIFEST_PATH}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, MANIFEST_PATH);
}

async function prepare(pool) {
  const roots = sourceRoots();
  const localIndex = await indexLocalMedia(roots);
  const liveReferences = await readLiveReferences(pool);
  const grouped = new Map();
  for (const reference of liveReferences) {
    const references = grouped.get(reference.source_url) ?? [];
    references.push(reference);
    grouped.set(reference.source_url, references);
  }

  let existing = { assets: [] };
  try {
    existing = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const previous = new Map(
    (existing.assets ?? []).map((asset) => [asset.sourceUrl, asset]),
  );
  const assets = [...grouped.entries()].map(([url, references]) => {
    const fresh = makeManifestAsset(url, references, localIndex);
    const old = previous.get(url);
    if (!old) return fresh;
    const preserveVerifiedDestination = old.destinationVerified === true;
    const preserveStatus = [
      "migrated",
      "destination-verified-db-failed",
      "failed",
      "rolled-back",
    ].includes(old.migrationStatus);
    return {
      ...fresh,
      ...Object.fromEntries(
        [
          ...(preserveVerifiedDestination
            ? ["objectKey", "publicUrl", "sha256", "destinationVerified"]
            : []),
          ...(preserveStatus
            ? ["migrationStatus", "failureReason", "migratedAt", "rollbackStatus"]
            : []),
        ]
          .filter((key) => old[key] !== undefined)
          .map((key) => [key, old[key]]),
      ),
      references: fresh.references.map((reference) => {
        const prior = old.references?.find(
          (candidate) =>
            candidate.table === reference.table &&
            candidate.recordId === reference.recordId &&
            candidate.field === reference.field,
        );
        return prior ? { ...reference, ...prior } : reference;
      }),
    };
  });
  for (const old of existing.assets ?? []) {
    if (!grouped.has(old.sourceUrl)) assets.push(old);
  }

  const manifest = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    databaseModified: assets.some(
      (asset) =>
        asset.migrationStatus === "migrated" ||
        asset.references.some((reference) => reference.databaseUpdated),
    ),
    sourceApiUsed: false,
    sourceAccessNote:
      "Cloudinary Admin API and public asset requests were unavailable (HTTP 401) during preparation; no source bytes were downloaded.",
    searchRoots: roots,
    summary: {
      liveCloudinaryReferenceFields: liveReferences.length,
      liveDistinctCloudinaryAssets: grouped.size,
      localExactMatches: assets.filter(
        (asset) => grouped.has(asset.sourceUrl) && asset.localSourcePath,
      ).length,
      replacementFilesNeeded: assets.filter(
        (asset) => grouped.has(asset.sourceUrl) && !asset.localSourcePath,
      ).length,
    },
    assets,
  };
  await writeManifest(manifest);
  console.log(
    JSON.stringify(
      {
        manifest: path.relative(PROJECT_ROOT, MANIFEST_PATH),
        databaseModified: false,
        sourceApiUsed: false,
        ...manifest.summary,
      },
      null,
      2,
    ),
  );
}

function validateReference(reference) {
  if (!VALID_TABLES.has(reference.table) || !VALID_FIELDS.has(reference.field)) {
    throw new Error("Manifest contains an unsupported database target.");
  }
}

async function updateReferences(pool, asset, updatedUrl) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const reference of asset.references) {
      validateReference(reference);
      const table = `"${reference.table}"`;
      const field = `"${reference.field}"`;
      const result = await client.query(
        `UPDATE ${table} SET ${field} = $1 WHERE id = $2 AND ${field} = $3 RETURNING id`,
        [updatedUrl, reference.recordId, reference.originalUrl],
      );
      if (result.rowCount === 0) {
        const current = await client.query(
          `SELECT ${field} AS value FROM ${table} WHERE id = $1`,
          [reference.recordId],
        );
        if (current.rows[0]?.value !== updatedUrl) {
          throw new Error(
            `Database value changed for ${reference.table} record ${reference.recordId}; no references were updated.`,
          );
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackReferences(pool, asset) {
  if (!asset.destinationVerified || !asset.publicUrl) {
    throw new Error(`No verified R2 destination exists for ${asset.assetId}.`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const reference of asset.references) {
      validateReference(reference);
      const result = await client.query(
        `UPDATE "${reference.table}" SET "${reference.field}" = $1 WHERE id = $2 AND "${reference.field}" = $3 RETURNING id`,
        [reference.originalUrl, reference.recordId, asset.publicUrl],
      );
      if (result.rowCount === 0) {
        const current = await client.query(
          `SELECT "${reference.field}" AS value FROM "${reference.table}" WHERE id = $1`,
          [reference.recordId],
        );
        if (current.rows[0]?.value !== reference.originalUrl) {
          throw new Error(
            `Rollback stopped: ${reference.table} record ${reference.recordId} no longer has the expected R2 URL.`,
          );
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadSourceMap() {
  const sourceMapPath = optionValue("--source-map");
  if (!sourceMapPath) return new Map();
  const resolved = path.resolve(sourceMapPath);
  const values = JSON.parse(await fs.readFile(resolved, "utf8"));
  if (!values || Array.isArray(values) || typeof values !== "object") {
    throw new Error("The source map must be a JSON object.");
  }
  return new Map(
    Object.entries(values).map(([key, value]) => [
      key,
      path.resolve(path.dirname(resolved), String(value)),
    ]),
  );
}

function sourceForAsset(asset, sourceMap) {
  return sourceMap.get(asset.assetId) ?? sourceMap.get(asset.sourceUrl) ?? null;
}

function safeError(error) {
  const message = String(error?.message ?? error ?? "Unknown error")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/(?:access.?key|secret.?key|authorization)\s*[:=]\s*\S+/gi, "[credential]")
    .slice(0, 400);
  return message || "Unknown error";
}

async function migrate(pool) {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  const sourceMap = await loadSourceMap();
  const storage = isDryRun() ? null : createR2Storage();
  const failures = [];
  let uploaded = 0;
  let updatedReferences = 0;

  for (const asset of manifest.assets) {
    const filePath = sourceForAsset(asset, sourceMap);
    if (!filePath) {
      if (!asset.destinationVerified) {
        asset.migrationStatus = "needs-replacement";
        asset.failureReason ??= `No replacement source was explicitly mapped for ${asset.sourceFilename}.`;
      }
      continue;
    }
    try {
      await fs.access(filePath);
      const contentType = contentTypeForFile(filePath);
      if (!contentType.startsWith(`${asset.mediaType}/`)) {
        throw new Error(
          `Mapped source type does not match the ${asset.mediaType} reference.`,
        );
      }
      const extension = path.extname(filePath).toLowerCase();
      const reference = asset.references[0];
      if (!reference) throw new Error("Asset has no database reference.");
      const slug = String(reference.recordSlug ?? reference.recordId)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || String(reference.recordId);
      const objectKey = `migration/${reference.table}/${slug}/${asset.assetId}${extension}`;
      if (isDryRun()) {
        const bytes = await fs.readFile(filePath);
        asset.localSourcePath = filePath;
        asset.objectKey = objectKey;
        asset.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        asset.destinationVerified = false;
        asset.migrationStatus = "dry-run-source-validated";
        asset.failureReason = null;
        asset.dryRunAt = new Date().toISOString();
        await writeManifest(manifest);
        console.log(`Dry-run validated source ${asset.assetId} (${asset.mediaType}); no upload or database write.`);
        continue;
      }
      const verified = await storage.uploadAndVerify({
        filePath,
        objectKey,
        contentType,
      });
      asset.localSourcePath = filePath;
      asset.objectKey = objectKey;
      asset.publicUrl = verified.publicUrl;
      asset.sha256 = verified.sha256;
      asset.destinationVerified = true;
      asset.migrationStatus = "destination-verified";
      asset.failureReason = null;
      asset.verifiedAt = new Date().toISOString();
      await writeManifest(manifest);

      await updateReferences(pool, asset, verified.publicUrl);
      for (const record of asset.references) {
        record.databaseUpdated = true;
        record.updatedUrl = verified.publicUrl;
      }
      asset.migrationStatus = "migrated";
      asset.migratedAt = new Date().toISOString();
      uploaded += 1;
      updatedReferences += asset.references.length;
      await writeManifest(manifest);
      console.log(`Verified and migrated ${asset.assetId} (${asset.mediaType}).`);
    } catch (error) {
      asset.migrationStatus = asset.destinationVerified
        ? "destination-verified-db-failed"
        : "failed";
      asset.failureReason = safeError(error);
      failures.push({ assetId: asset.assetId, reason: asset.failureReason });
      await writeManifest(manifest);
      console.error(`Migration failed for ${asset.assetId}: ${asset.failureReason}`);
    }
  }

  manifest.databaseModified = updatedReferences > 0;
  manifest.lastMigrationAttemptAt = new Date().toISOString();
  await writeManifest(manifest);
  console.log(
    JSON.stringify(
      {
        assetsUploadedAndVerified: uploaded,
        databaseReferencesUpdated: updatedReferences,
        failedAssets: failures.length,
        dryRun: isDryRun(),
        replacementFilesNeeded: manifest.assets.filter(
          (asset) => asset.migrationStatus === "needs-replacement",
        ).length,
      },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
}

async function rollback(pool) {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  let restored = 0;
  for (const asset of manifest.assets) {
    if (
      asset.migrationStatus !== "migrated" &&
      asset.migrationStatus !== "destination-verified-db-failed" &&
      asset.migrationStatus !== "destination-verified"
    ) {
      continue;
    }
    await rollbackReferences(pool, asset);
    for (const reference of asset.references) {
      reference.databaseUpdated = false;
      reference.updatedUrl = null;
    }
    asset.migrationStatus = "rolled-back";
    asset.rollbackStatus = "database-restored";
    asset.rolledBackAt = new Date().toISOString();
    restored += asset.references.length;
    await writeManifest(manifest);
  }
  manifest.databaseModified = false;
  console.log(
    JSON.stringify(
      {
        databaseReferencesRestored: restored,
        r2ObjectsDeleted: false,
        manifest: path.relative(PROJECT_ROOT, MANIFEST_PATH),
      },
      null,
      2,
    ),
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});
try {
  if (hasOption("--migrate")) await migrate(pool);
  else if (hasOption("--rollback")) await rollback(pool);
  else await prepare(pool);
} catch (error) {
  console.error(`Media migration stopped: ${safeError(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
