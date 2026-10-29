import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  buildMediaObjectKey,
  buildPublicMediaUrl,
  createR2Storage,
  getObjectKeyFromPublicUrl,
  R2ConfigurationError,
  validateR2ObjectKey,
} from "../src/services/r2Storage.js";
import {
  deleteMedia,
  deleteReplacedR2Media,
  detectMediaContentType,
  uploadMedia,
} from "../src/controllers/uploadController.js";

const R2_ENV = {
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET_NAME: "tnh-media",
  R2_PUBLIC_BASE_URL: "https://media.example.test",
};

function fixturePng() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("test image bytes"),
  ]);
}

function fixtureJpeg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function fixtureWebp() {
  return Buffer.from("RIFF\x04\x00\x00\x00WEBP");
}

function fixtureMp4() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftyp"),
    Buffer.from("isom"),
    Buffer.from("test video bytes"),
  ]);
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

class MemoryR2Client {
  objects = new Map();
  putCount = 0;
  deleteCount = 0;

  async send(command) {
    const input = command.input;
    if (command instanceof PutObjectCommand) {
      this.putCount += 1;
      this.objects.set(input.Key, {
        bytes: Buffer.from(input.Body),
        ContentLength: input.ContentLength,
        ContentType: input.ContentType,
        Metadata: input.Metadata,
      });
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object) {
        const error = new Error("Not Found");
        error.name = "NotFound";
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {
        ContentLength: object.ContentLength,
        ContentType: object.ContentType,
        Metadata: object.Metadata,
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object) throw new Error("missing fixture object");
      return { Body: Readable.from([object.bytes]) };
    }
    if (command instanceof DeleteObjectCommand) {
      this.deleteCount += 1;
      this.objects.delete(input.Key);
      return {};
    }
    throw new Error(`Unexpected R2 command: ${command.constructor.name}`);
  }
}

function publicFetch(client) {
  return async (url, options = {}) => {
    const objectKey = new URL(url).pathname
      .slice(1)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const object = client.objects.get(objectKey);
    if (!object) return new Response(null, { status: 404 });
    const headers = {
      "content-type": object.ContentType,
      "content-length": String(object.ContentLength),
    };
    if (options.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    if (options.headers?.Range) {
      headers["content-range"] = `bytes 0-0/${object.ContentLength}`;
      return new Response(object.bytes.subarray(0, 1), {
        status: 206,
        headers,
      });
    }
    return new Response(object.bytes, { status: 200, headers });
  };
}

function makeStorage(client, env = R2_ENV) {
  return createR2Storage(env, {
    client,
    fetchImpl: (url, options) => publicFetch(client)(url, options),
  });
}

test("R2 configuration rejects missing credentials and API endpoints as public URLs", () => {
  assert.throws(
    () => createR2Storage({}),
    (error) =>
      error instanceof R2ConfigurationError &&
      error.missing.length === 5,
  );
  assert.throws(
    () =>
      createR2Storage({
        ...R2_ENV,
        R2_PUBLIC_BASE_URL: "https://account.r2.cloudflarestorage.com/bucket",
      }),
    (error) =>
      error instanceof R2ConfigurationError &&
      error.invalid.includes("R2_PUBLIC_BASE_URL"),
  );
  assert.throws(
    () =>
      createR2Storage({
        ...R2_ENV,
        R2_ACCOUNT_ID: "a".repeat(32) + ".r2.cloudflarestorage.com",
      }),
    (error) =>
      error instanceof R2ConfigurationError &&
      error.invalid.includes("R2_ACCOUNT_ID"),
  );
});

test("R2 object keys are scoped and public URLs map only to configured media domain", () => {
  const key = buildMediaObjectKey("services", "Hair Style", "photo.webp", fixturePng());
  assert.match(key, /^services\/hair-style\/[a-f0-9]{64}\.webp$/);
  assert.throws(() => validateR2ObjectKey("services/../private.webp"));
  const url = buildPublicMediaUrl(R2_ENV.R2_PUBLIC_BASE_URL, key);
  assert.equal(getObjectKeyFromPublicUrl(url, R2_ENV), key);
  assert.equal(
    getObjectKeyFromPublicUrl("https://untrusted.example/" + key, R2_ENV),
    null,
  );
});

test("image upload verifies bytes, public delivery, and reuses verified object on retry", async () => {
  const client = new MemoryR2Client();
  const storage = makeStorage(client);
  const buffer = fixturePng();
  const objectKey = "services/test/image.png";
  const first = await storage.uploadAndVerify({
    buffer,
    originalName: "image.png",
    contentType: "image/png",
    objectKey,
  });
  const retry = await storage.uploadAndVerify({
    buffer,
    originalName: "image.png",
    contentType: "image/png",
    objectKey,
  });
  assert.equal(first.sha256, retry.sha256);
  assert.equal(first.publicUrl, retry.publicUrl);
  assert.equal(client.putCount, 1);
});

test("video upload verifies content and HTTP range support", async () => {
  const client = new MemoryR2Client();
  const storage = makeStorage(client);
  const result = await storage.uploadAndVerify({
    buffer: fixtureMp4(),
    originalName: "clip.mp4",
    contentType: "video/mp4",
    objectKey: "services/test/clip.mp4",
  });
  assert.equal(result.contentType, "video/mp4");
});

test("upload handlers validate actual formats and return R2 URL and key", async () => {
  const png = fixturePng();
  const mp4 = fixtureMp4();
  assert.equal(detectMediaContentType(png, "image.png", "image"), "image/png");
  assert.equal(detectMediaContentType(mp4, "clip.mp4", "video"), "video/mp4");
  assert.equal(detectMediaContentType(png, "image.jpg", "image"), "image/png");

  const storageClient = new MemoryR2Client();
  const storage = makeStorage(storageClient);
  const storageFactory = () => storage;
  const imageResponse = createResponse();
  await uploadMedia(
    {
      file: { buffer: png, originalname: "image.png" },
      body: { type: "categories", slug: "Skin" },
    },
    imageResponse,
    "image",
    { storageFactory },
  );
  assert.equal(imageResponse.statusCode, 201);
  assert.equal(imageResponse.body.mediaType, "image");
  assert.match(imageResponse.body.imageUrl, /^https:\/\/media\.example\.test\/categories\//);
  assert.equal(imageResponse.body.objectKey, imageResponse.body.publicId);

  const videoResponse = createResponse();
  await uploadMedia(
    {
      file: { buffer: mp4, originalname: "clip.mp4" },
      body: { type: "services", slug: "Hair" },
    },
    videoResponse,
    "video",
    { storageFactory },
  );
  assert.equal(videoResponse.statusCode, 201);
  assert.equal(videoResponse.body.mediaType, "video");
});

test("image validation detects JPEG, PNG, and WebP from file bytes", () => {
  assert.equal(detectMediaContentType(fixtureJpeg(), "image.jpg", "image"), "image/jpeg");
  assert.equal(detectMediaContentType(fixturePng(), "image.png", "image"), "image/png");
  assert.equal(detectMediaContentType(fixtureWebp(), "image.webp", "image"), "image/webp");
  assert.equal(detectMediaContentType(fixtureJpeg(), "image.JPEG", "image"), "image/jpeg");
  assert.equal(detectMediaContentType(fixturePng(), "image.PNG", "image"), "image/png");
  assert.equal(detectMediaContentType(fixtureWebp(), "image.WEBP", "image"), "image/webp");

  assert.equal(detectMediaContentType(fixtureJpeg(), "renamed.webp", "image"), "image/jpeg");
  assert.equal(detectMediaContentType(fixturePng(), "renamed.JPG", "image"), "image/png");
  assert.throws(
    () => detectMediaContentType(Buffer.from("not an image"), "renamed.webp", "image"),
    /contents do not match/,
  );
  assert.throws(
    () => detectMediaContentType(fixtureJpeg(), "image.svg", "image"),
    /Unsupported image file extension/,
  );
});

test("nails-009.webp uploads as JPEG with matching public content type", async () => {
  const buffer = await readFile(
    new URL(
      "../../tnh-salon/public/images/gallery/nails/nails-009.webp",
      import.meta.url,
    ),
  );
  assert.equal(buffer.subarray(0, 3).toString("hex"), "ffd8ff");
  assert.equal(detectMediaContentType(buffer, "nails-009.webp", "image"), "image/jpeg");

  const storageClient = new MemoryR2Client();
  const storage = makeStorage(storageClient);
  const response = createResponse();
  await uploadMedia(
    {
      file: { buffer, originalname: "nails-009.webp" },
      body: { type: "services", slug: "validation-test" },
    },
    response,
    "image",
    { storageFactory: () => storage },
  );

  assert.equal(response.statusCode, 201);
  assert.match(response.body.imageUrl, /\.jpg$/);
  const object = storageClient.objects.get(response.body.objectKey);
  assert.equal(object.ContentType, "image/jpeg");
  assert.deepEqual(object.bytes, buffer);

  const publicResponse = await publicFetch(storageClient)(response.body.imageUrl);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), buffer);
});

test("upload handler reports missing R2 configuration without crashing", async () => {
  const response = createResponse();
  await uploadMedia(
    {
      file: { buffer: fixturePng(), originalname: "image.png" },
      body: { type: "services", slug: "Facial" },
    },
    response,
    "image",
    { storageFactory: () => createR2Storage({}) },
  );
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "R2_NOT_CONFIGURED");
});

test("upload handler explains that the R2 S3 endpoint is not a public media URL", async () => {
  const response = createResponse();
  await uploadMedia(
    {
      file: { buffer: fixturePng(), originalname: "image.png" },
      body: { type: "categories", slug: "skin" },
    },
    response,
    "image",
    {
      storageFactory: () =>
        createR2Storage({
          ...R2_ENV,
          R2_ACCOUNT_ID: "a".repeat(32) + ".r2.cloudflarestorage.com",
          R2_PUBLIC_BASE_URL:
            "https://account.r2.cloudflarestorage.com/bucket",
        }),
    },
  );
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, "R2_NOT_CONFIGURED");
  assert.deepEqual(response.body.invalidConfiguration, [
    "R2_ACCOUNT_ID",
    "R2_PUBLIC_BASE_URL",
  ]);
  assert.match(response.body.message, /bare 32-character Cloudflare account ID/);
});

test("failed upload is reported and does not return an R2 URL", async () => {
  const response = createResponse();
  let deleteCount = 0;
  await uploadMedia(
    {
      file: { buffer: fixturePng(), originalname: "image.png" },
      body: { type: "services", slug: "Facial" },
    },
    response,
    "image",
    {
      storageFactory: () => ({
        publicUrl: (objectKey) =>
          `https://media.example.test/${objectKey}`,
        uploadAndVerify: async () => {
          throw new Error("mock upload failure");
        },
        deleteObject: async () => {
          deleteCount += 1;
        },
      }),
      countReferences: async () => 1,
    },
  );
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, "R2_UPLOAD_FAILED");
  assert.equal(response.body.imageUrl, undefined);
  assert.equal(deleteCount, 0);
});

test("public verification failures retain the HTTP status and stage for diagnostics", async () => {
  const client = new MemoryR2Client();
  const storage = createR2Storage(R2_ENV, {
    client,
    fetchImpl: async (url, options = {}) => {
      const response = await publicFetch(client)(url, options);
      if (options.method === "HEAD") {
        return new Response(null, { status: 403 });
      }
      return response;
    },
  });
  await assert.rejects(
    storage.uploadAndVerify({
      buffer: fixturePng(),
      originalName: "image.png",
      contentType: "image/png",
      objectKey: "categories/test/image.png",
    }),
    (error) =>
      error.name === "R2VerificationError" &&
      error.stage === "public-head" &&
      error.httpStatus === 403 &&
      /HTTP 403/.test(error.message),
  );
});

test("media deletion refuses referenced objects and deletes only an unreferenced key", async () => {
  const client = new MemoryR2Client();
  const storage = makeStorage(client);
  const key = "services/test/orphan.webp";
  client.objects.set(key, {
    bytes: fixturePng(),
    ContentLength: fixturePng().length,
    ContentType: "image/png",
    Metadata: {},
  });
  const blocked = createResponse();
  await deleteMedia(
    { body: { objectKey: key } },
    blocked,
    {
      storageFactory: () => storage,
      countReferences: async () => 1,
    },
  );
  assert.equal(blocked.statusCode, 409);
  assert.equal(client.deleteCount, 0);

  const deleted = createResponse();
  await deleteMedia(
    { body: { objectKey: key } },
    deleted,
    {
      storageFactory: () => storage,
      countReferences: async () => 0,
    },
  );
  assert.equal(deleted.statusCode, 200);
  assert.equal(client.deleteCount, 1);
});

test("replacement cleanup occurs only after old URL is no longer referenced", async () => {
  const client = new MemoryR2Client();
  const storage = makeStorage(client);
  const key = "services/test/old.webp";
  client.objects.set(key, {
    bytes: fixturePng(),
    ContentLength: fixturePng().length,
    ContentType: "image/png",
    Metadata: {},
  });
  const oldUrl = storage.publicUrl(key);
  await deleteReplacedR2Media(oldUrl, "https://media.example.test/new.webp", {
    env: R2_ENV,
    storageFactory: () => storage,
    countReferences: async () => 1,
  });
  assert.equal(client.deleteCount, 0);
  await deleteReplacedR2Media(oldUrl, "https://media.example.test/new.webp", {
    env: R2_ENV,
    storageFactory: () => storage,
    countReferences: async () => 0,
  });
  assert.equal(client.deleteCount, 1);
});
