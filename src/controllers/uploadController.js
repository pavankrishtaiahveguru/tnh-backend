import db from "../config/database.js";
import {
  buildMediaObjectKey,
  createR2Storage,
  getObjectKeyFromPublicUrl,
  R2ConfigurationError,
} from "../services/r2Storage.js";

const ALLOWED_FOLDERS = new Set(["categories", "services"]);

const MEDIA_TYPES = {
  image: new Map([
    [".avif", { contentType: "image/avif", signature: "avif" }],
    [".gif", { contentType: "image/gif", signature: "gif" }],
    [".jpeg", { contentType: "image/jpeg", signature: "jpeg" }],
    [".jpg", { contentType: "image/jpeg", signature: "jpeg" }],
    [".png", { contentType: "image/png", signature: "png" }],
    [".webp", { contentType: "image/webp", signature: "webp" }],
  ]),
  video: new Map([
    [".m4v", { contentType: "video/x-m4v", signature: "mp4" }],
    [".mov", { contentType: "video/quicktime", signature: "mp4" }],
    [".mp4", { contentType: "video/mp4", signature: "mp4" }],
    [".webm", { contentType: "video/webm", signature: "webm" }],
  ]),
};

export function detectMediaContentType(buffer, originalName, mediaType) {
  const extension = String(originalName).match(/\.[^.]+$/)?.[0].toLowerCase();
  const definition = MEDIA_TYPES[mediaType]?.get(extension);
  if (!definition) throw new Error(`Unsupported ${mediaType} file extension.`);

  if (mediaType === "image") {
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return "image/jpeg";
    }
    if (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
    ) {
      return "image/png";
    }
    if (buffer.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) {
      return "image/gif";
    }
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
    if (
      buffer.length >= 12 &&
      buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
      /^(avif|avis)$/.test(buffer.subarray(8, 12).toString("ascii"))
    ) {
      return "image/avif";
    }
    throw new Error(`File contents do not match the ${mediaType} format.`);
  }

  let signatureMatches = false;
  switch (definition.signature) {
    case "mp4":
      signatureMatches =
        buffer.length >= 12 &&
        buffer.subarray(4, 8).toString("ascii") === "ftyp";
      break;
    case "webm":
      signatureMatches =
        buffer.length >= 4 &&
        buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      break;
    default:
      break;
  }

  if (!signatureMatches) throw new Error(`File contents do not match the ${mediaType} format.`);
  return definition.contentType;
}

function safeSlug(value) {
  return (
    String(value ?? "media")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "media"
  );
}

function configErrorResponse(res, error) {
  if (!(error instanceof R2ConfigurationError)) return false;
  const invalidPublicDomain = error.invalid.includes("R2_PUBLIC_BASE_URL");
  console.error("R2 configuration rejected.", {
    missing: error.missing,
    invalid: error.invalid,
  });
  const invalidAccountId = error.invalid.includes("R2_ACCOUNT_ID");
  return res.status(503).json({
    success: false,
    code: "R2_NOT_CONFIGURED",
    message:
      invalidAccountId && invalidPublicDomain
        ? "R2 configuration is invalid. Set R2_ACCOUNT_ID to the bare 32-character Cloudflare account ID and R2_PUBLIC_BASE_URL to the HTTPS public media domain, not the S3 API endpoint, then restart the backend."
        : invalidAccountId
          ? "R2_ACCOUNT_ID must contain the bare 32-character Cloudflare account ID, not an endpoint hostname. Correct it and restart the backend."
          : invalidPublicDomain
            ? "R2_PUBLIC_BASE_URL must be the HTTPS public media domain, not the R2 S3 API endpoint. Correct it and restart the backend."
            : "Media storage configuration is incomplete. Set the reported R2 variables, then restart the backend.",
    missingConfiguration: error.missing,
    invalidConfiguration: error.invalid,
  });
}

function logR2Failure(operation, error) {
  const diagnostic = { errorName: error?.name ?? "Error" };
  const errorCode = error?.Code ?? error?.code;
  if (typeof errorCode === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(errorCode)) {
    diagnostic.errorCode = errorCode;
  }
  if (typeof error?.stage === "string" && /^[a-z-]{1,40}$/.test(error.stage)) {
    diagnostic.stage = error.stage;
  }
  const httpStatus = error?.httpStatus ?? error?.$metadata?.httpStatusCode;
  if (Number.isInteger(httpStatus)) diagnostic.httpStatus = httpStatus;
  if (typeof error?.message === "string") {
    diagnostic.reason = error.message.slice(0, 240);
  }
  console.error(`R2 ${operation} failed.`, diagnostic);
}

async function cleanupUnreferencedUpload(objectKey, storage, countReferences) {
  let referenced;
  try {
    referenced = await countReferences(storage.publicUrl(objectKey));
  } catch {
    console.error("Failed-upload cleanup skipped because media reference checks failed.");
    return;
  }
  if (referenced > 0) return;
  try {
    await storage.deleteObject(objectKey);
  } catch (error) {
    logR2Failure("failed-upload cleanup", error);
  }
}

export async function uploadMedia(req, res, mediaType, dependencies = {}) {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: `A ${mediaType} file is required.`,
    });
  }

  const folderType = req.body?.type;
  if (!ALLOWED_FOLDERS.has(folderType)) {
    return res.status(400).json({
      success: false,
      message: "Invalid media folder.",
    });
  }

  let contentType;
  try {
    contentType = detectMediaContentType(
      req.file.buffer,
      req.file.originalname,
      mediaType,
    );
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  const slug = safeSlug(req.body?.slug);
  let objectKey;
  let storage;
  try {
    const storageFactory = dependencies.storageFactory ?? createR2Storage;
    storage = storageFactory();
    const objectName =
      mediaType === "image"
        ? req.file.originalname.replace(
            /\.[^.]+$/,
            {
              "image/avif": ".avif",
              "image/gif": ".gif",
              "image/jpeg": ".jpg",
              "image/png": ".png",
              "image/webp": ".webp",
            }[contentType],
          )
        : req.file.originalname;
    objectKey = buildMediaObjectKey(
      folderType,
      slug,
      objectName,
      req.file.buffer,
    );
    const result = await storage.uploadAndVerify({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      contentType,
      objectKey,
    });

    return res.status(201).json({
      success: true,
      imageUrl: result.publicUrl,
      mediaUrl: result.publicUrl,
      publicId: objectKey,
      objectKey,
      mediaType,
    });
  } catch (error) {
    if (configErrorResponse(res, error)) return;
    if (objectKey && storage) {
      const countReferences =
        dependencies.countReferences ?? countMediaReferences;
      await cleanupUnreferencedUpload(objectKey, storage, countReferences);
    }
    logR2Failure("media upload", error);
    return res.status(502).json({
      success: false,
      code: "R2_UPLOAD_FAILED",
      message: `Cloudflare R2 could not verify the ${mediaType}. Check the R2 bucket permissions and public media-domain configuration, then retry.`,
    });
  }
}

export async function uploadImage(req, res) {
  return uploadMedia(req, res, "image");
}

export async function uploadVideo(req, res) {
  return uploadMedia(req, res, "video");
}

async function countMediaReferences(url) {
  const [categories] = await db.query(
    `SELECT COUNT(*)::int AS count FROM categories WHERE image = ? OR image_url = ?`,
    [url, url],
  );
  const [services] = await db.query(
    `SELECT COUNT(*)::int AS count FROM services WHERE image = ? OR image_url = ?`,
    [url, url],
  );
  return Number(categories[0]?.count ?? 0) + Number(services[0]?.count ?? 0);
}

export async function deleteMedia(req, res, dependencies = {}) {
  const objectKey = req.body?.objectKey;
  if (typeof objectKey !== "string" || !objectKey) {
    return res.status(400).json({
      success: false,
      message: "A media object key is required.",
    });
  }

  try {
    const storage = (dependencies.storageFactory ?? createR2Storage)();
    const publicUrl = storage.publicUrl(objectKey);
    const countReferences = dependencies.countReferences ?? countMediaReferences;
    if (await countReferences(publicUrl) > 0) {
      return res.status(409).json({
        success: false,
        message: "This media object is still referenced and cannot be deleted.",
      });
    }
    await storage.deleteObject(objectKey);
    return res.status(200).json({ success: true });
  } catch (error) {
    if (configErrorResponse(res, error)) return;
    logR2Failure("media deletion", error);
    return res.status(502).json({
      success: false,
      message: "Media deletion failed. Please try again.",
    });
  }
}

export async function deleteReplacedR2Media(
  oldUrl,
  newUrl,
  dependencies = {},
) {
  if (!oldUrl || oldUrl === newUrl) return;
  let storage;
  try {
    storage = (dependencies.storageFactory ?? createR2Storage)();
  } catch (error) {
    if (error instanceof R2ConfigurationError) return;
    throw error;
  }

  const objectKey = getObjectKeyFromPublicUrl(
    oldUrl,
    dependencies.env ?? process.env,
  );
  if (!objectKey) return;
  try {
    const countReferences = dependencies.countReferences ?? countMediaReferences;
    if (await countReferences(oldUrl) > 0) return;
  } catch {
    console.error("Replaced media cleanup skipped because reference checks failed.");
    return;
  }
  try {
    await storage.deleteObject(objectKey);
  } catch {
    console.error("Replaced R2 media is no longer referenced but could not be deleted.");
  }
}
