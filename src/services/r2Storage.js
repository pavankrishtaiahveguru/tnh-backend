import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".m4v", "video/x-m4v"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
]);

const ALLOWED_KEY_PREFIXES = [
  "categories/",
  "services/",
  "migration/categories/",
  "migration/services/",
];

export class R2ConfigurationError extends Error {
  constructor({ missing = [], invalid = [] } = {}) {
    const details = [
      ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
      ...(invalid.length ? [`invalid: ${invalid.join(", ")}`] : []),
    ];
    super(`R2 configuration ${details.join("; ")}`);
    this.name = "R2ConfigurationError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

export function getR2Config(env = process.env) {
  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_BASE_URL",
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new R2ConfigurationError({ missing });

  const accountId = env.R2_ACCOUNT_ID.trim();
  const invalid = [];
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    invalid.push("R2_ACCOUNT_ID");
  }

  let publicBase;
  try {
    publicBase = new URL(env.R2_PUBLIC_BASE_URL);
  } catch {
    invalid.push("R2_PUBLIC_BASE_URL");
  }
  if (publicBase) {
    if (
      publicBase.protocol !== "https:" ||
      publicBase.username ||
      publicBase.password ||
      publicBase.search ||
      publicBase.hash ||
      publicBase.hostname.endsWith(".r2.cloudflarestorage.com")
    ) {
      invalid.push("R2_PUBLIC_BASE_URL");
    }
  }
  if (invalid.length) throw new R2ConfigurationError({ invalid });

  return {
    accountId,
    accessKeyId: env.R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY.trim(),
    bucketName: env.R2_BUCKET_NAME.trim(),
    publicBaseUrl: publicBase.toString().replace(/\/+$/, ""),
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

export function contentTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES.get(extension);
  if (!contentType) {
    throw new Error(`Unsupported media file extension: ${extension || "(none)"}`);
  }
  return contentType;
}

export function validateR2ObjectKey(objectKey) {
  if (
    typeof objectKey !== "string" ||
    objectKey.length === 0 ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    objectKey.split("/").some((part) => !part || part === "." || part === "..") ||
    !ALLOWED_KEY_PREFIXES.some((prefix) => objectKey.startsWith(prefix))
  ) {
    throw new Error("Invalid R2 media object key.");
  }
  return objectKey;
}

export function buildPublicMediaUrl(publicBaseUrl, objectKey) {
  validateR2ObjectKey(objectKey);
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  return `${publicBaseUrl.replace(/\/+$/, "")}/${encodedKey}`;
}

export function buildMediaObjectKey(type, slug, originalName, content) {
  if (!["categories", "services"].includes(type)) {
    throw new Error("Invalid R2 media type.");
  }
  const safeSlug =
    String(slug ?? "media")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "media";
  const extension = path.extname(originalName).toLowerCase();
  contentTypeForFile(`media${extension}`);
  const identifier = content
    ? createHash("sha256").update(content).digest("hex")
    : randomUUID();
  return `${type}/${safeSlug}/${identifier}${extension}`;
}

async function hashReadable(readable) {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of readable) {
    hash.update(chunk);
    byteLength += chunk.length;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

async function hashFile(filePath) {
  return hashReadable(createReadStream(filePath));
}

function verificationError(stage, reason, httpStatus) {
  const error = new Error(reason);
  error.name = "R2VerificationError";
  error.stage = stage;
  if (Number.isInteger(httpStatus)) error.httpStatus = httpStatus;
  return error;
}

function stageError(error, stage) {
  const staged = error instanceof Error ? error : new Error(String(error));
  staged.stage ??= stage;
  return staged;
}

export function getObjectKeyFromPublicUrl(publicUrl, env = process.env) {
  const config = getR2Config(env);
  let candidate;
  try {
    candidate = new URL(publicUrl);
  } catch {
    return null;
  }
  const base = new URL(config.publicBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (
    candidate.origin !== base.origin ||
    !candidate.pathname.startsWith(`${basePath}/`)
  ) {
    return null;
  }
  const encodedKey = candidate.pathname.slice(basePath.length + 1);
  let objectKey;
  try {
    objectKey = encodedKey
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    return null;
  }
  try {
    return validateR2ObjectKey(objectKey);
  } catch {
    return null;
  }
}

export function createR2Storage(env = process.env, options = {}) {
  const config = getR2Config(env);
  const client = options.client ?? new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const fetchImpl = options.fetchImpl ?? fetch;

  async function verifyStoredObject(objectKey, expected) {
    let head;
    try {
      head = await client.send(
        new HeadObjectCommand({
          Bucket: config.bucketName,
          Key: objectKey,
        }),
      );
    } catch (error) {
      throw stageError(error, "storage-head");
    }
    if (
      head.ContentLength !== expected.byteLength ||
      head.ContentType !== expected.contentType ||
      head.Metadata?.sha256 !== expected.sha256
    ) {
      throw verificationError(
        "storage-metadata",
        `R2 object metadata mismatch for ${objectKey}.`,
      );
    }

    let stored;
    try {
      stored = await client.send(
        new GetObjectCommand({
          Bucket: config.bucketName,
          Key: objectKey,
        }),
      );
    } catch (error) {
      throw stageError(error, "storage-download");
    }
    const storedHash = await hashReadable(stored.Body);
    if (
      storedHash.byteLength !== expected.byteLength ||
      storedHash.sha256 !== expected.sha256
    ) {
      throw verificationError(
        "storage-content",
        `R2 object content mismatch for ${objectKey}.`,
      );
    }

    const publicUrl = buildPublicMediaUrl(config.publicBaseUrl, objectKey);
    let publicHead;
    try {
      publicHead = await fetchImpl(publicUrl, { method: "HEAD" });
    } catch (error) {
      throw stageError(error, "public-head");
    }
    if (!publicHead.ok) {
      throw verificationError(
        "public-head",
        `R2 public URL verification failed with HTTP ${publicHead.status}.`,
        publicHead.status,
      );
    }
    if (
      publicHead.headers.get("content-type")?.split(";")[0] !==
        expected.contentType ||
      (publicHead.headers.get("content-length") &&
        Number(publicHead.headers.get("content-length")) !== expected.byteLength)
    ) {
      throw verificationError(
        "public-metadata",
        `R2 public URL metadata mismatch for ${objectKey}.`,
      );
    }

    let publicResponse;
    try {
      publicResponse = await fetchImpl(publicUrl);
    } catch (error) {
      throw stageError(error, "public-download");
    }
    if (!publicResponse.ok || !publicResponse.body) {
      throw verificationError(
        "public-download",
        `R2 public media download failed with HTTP ${publicResponse.status}.`,
        publicResponse.status,
      );
    }
    const publicHash = await hashReadable(publicResponse.body);
    if (
      publicHash.byteLength !== expected.byteLength ||
      publicHash.sha256 !== expected.sha256
    ) {
      throw verificationError(
        "public-content",
        `R2 public media content mismatch for ${objectKey}.`,
      );
    }

    if (expected.contentType.startsWith("video/")) {
      let rangeResponse;
      try {
        rangeResponse = await fetchImpl(publicUrl, {
          headers: { Range: "bytes=0-0" },
        });
      } catch (error) {
        throw stageError(error, "public-range");
      }
      const contentRange = rangeResponse.headers.get("content-range") ?? "";
      await rangeResponse.body?.cancel();
      if (
        rangeResponse.status !== 206 ||
        !/^bytes 0-0\/\d+$/.test(contentRange)
      ) {
        throw verificationError(
          "public-range",
          `R2 video range-request verification failed for ${objectKey}.`,
          rangeResponse.status,
        );
      }
    }

    return { publicUrl, ...expected };
  }

  async function objectExists(objectKey) {
    validateR2ObjectKey(objectKey);
    try {
      const metadata = await client.send(
        new HeadObjectCommand({
          Bucket: config.bucketName,
          Key: objectKey,
        }),
      );
      return { exists: true, metadata };
    } catch (error) {
      if (
        error?.name === "NotFound" ||
        error?.name === "NoSuchKey" ||
        error?.$metadata?.httpStatusCode === 404
      ) {
        return { exists: false, metadata: null };
      }
      throw error;
    }
  }

  async function uploadAndVerify({
    filePath,
    buffer,
    originalName,
    objectKey,
    contentType,
  }) {
    validateR2ObjectKey(objectKey);
    if ((filePath == null) === (buffer == null)) {
      throw new Error("Provide exactly one R2 upload source.");
    }
    const sourceName = originalName ?? (filePath ? path.basename(filePath) : "upload");
    const resolvedContentType =
      contentType ?? contentTypeForFile(sourceName);
    const source = buffer
      ? {
          sha256: createHash("sha256").update(buffer).digest("hex"),
          byteLength: buffer.length,
        }
      : await hashFile(filePath);
    const { exists, metadata } = await objectExists(objectKey);
    const alreadyMatches =
      exists &&
      metadata.ContentLength === source.byteLength &&
      metadata.ContentType === resolvedContentType &&
      metadata.Metadata?.sha256 === source.sha256;
    if (alreadyMatches) {
      return verifyStoredObject(objectKey, {
        ...source,
        contentType: resolvedContentType,
      });
    }

    const uploadParams = {
      Bucket: config.bucketName,
      Key: objectKey,
      ContentType: resolvedContentType,
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: {
        sha256: source.sha256,
        "original-filename": sourceName.slice(0, 200),
      },
    };
    if (buffer) {
      await client.send(
        new PutObjectCommand({
          ...uploadParams,
          Body: buffer,
          ContentLength: source.byteLength,
        }),
      );
    } else {
      const upload = new Upload({
        client,
        params: {
          ...uploadParams,
          Body: createReadStream(filePath),
          ContentLength: source.byteLength,
        },
        leavePartsOnError: false,
      });
      await upload.done();
    }

    return verifyStoredObject(objectKey, {
      ...source,
      contentType: resolvedContentType,
    });
  }

  async function getObjectMetadata(objectKey) {
    validateR2ObjectKey(objectKey);
    return client.send(
      new HeadObjectCommand({
        Bucket: config.bucketName,
        Key: objectKey,
      }),
    );
  }

  async function deleteObject(objectKey) {
    validateR2ObjectKey(objectKey);
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucketName,
        Key: objectKey,
      }),
    );
  }

  return {
    bucketName: config.bucketName,
    publicUrl: (objectKey) =>
      buildPublicMediaUrl(config.publicBaseUrl, objectKey),
    objectExists,
    getObjectMetadata,
    deleteObject,
    uploadAndVerify,
  };
}
