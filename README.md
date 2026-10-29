# The Nail Hue — Backend

Node.js + Express REST API powering The Nail Hue salon website (`tnh-salon`) and its admin panel. It serves the service catalogue and branches, handles admin authentication, image uploads, and Excel catalogue import/export.

## Overview

- **Public API** — services catalogue (with filters, search, pagination), categories/sub-categories, branches.
- **Admin API** — JWT-protected CRUD for services and categories, branch updates, media uploads to **Cloudflare R2** (bucket `tnh-service-media` — the active media storage provider, replacing Cloudinary), and reference-format Excel export/import of the catalogue.
- **Database** — PostgreSQL on [Neon](https://neon.tech) via raw SQL (`pg`, no ORM).

## Features

### REST API
- JSON responses shaped `{ success, message?, data?, errors? }`
- Health check at `GET /health`
- Centralized 404 and error handlers

### Services Catalogue
- Public list with server-side **search, category/sub-category, branch, gender (audience), status** filters
- **Pagination** (`page`, `limit` — default 24, max 50) with sub-category facet counts, plus a legacy full-list mode when no pagination params are sent
- Whitelisted sort keys: `menu` (default), `nameAsc`, `nameDesc`, `priceAsc`, `priceDesc`
- `GET /api/services/count` — unfiltered active-service total (single integer, no rows fetched)
- Pricing models: fixed, size-based, variant, "from" — variants stored in `service_variants`

### Branches
- Public branch listing; admin branch profile update (name, phone, email, address, hours, active flag)
- Services ↔ branches availability via the `service_branches` join table

### Authentication
- Admin login (`POST /api/auth/login`) issuing a **JWT** (`jsonwebtoken`), passwords hashed with **bcryptjs**
- `GET /api/auth/me` returns the current admin profile
- Generic "invalid email or password" for unknown email, wrong password *and* inactive account — email existence is never revealed
- `Authorization: Bearer <token>` middleware protects all admin routes

### Uploads
- `POST /api/upload/image` and `/api/upload/video` — admin-only media uploads to **Cloudflare R2** (5 MB image / 250 MB video limit; folder whitelist: `categories`, `services`)
- Supported image extensions: `.avif`, `.gif`, `.jpg`/`.jpeg`, `.png`, `.webp`; supported video extensions: `.m4v`, `.mov`, `.mp4`, `.webm`
- Uploads are **content-sniffed from file bytes** (magic-number signature detection), not trusted from the declared MIME type — a renamed extension fails validation (see the notes below on image signature handling)
- Success returns `{ success, imageUrl, mediaUrl, publicId, objectKey, mediaType }` where `imageUrl` is the full public R2 HTTPS URL
- `DELETE /api/upload/media` — admin-only deletion of an unreferenced R2 object (returns `409` if the URL is still referenced by `categories` or `services`)

### Catalogue Import / Export
- `GET /api/catalog/export` — streams the live catalogue as a reference-format `.xlsx` (ExcelJS; 2 sheets, 17 service columns)
- `POST /api/catalog/import` — validates the entire workbook **before** any database change, then applies it in a single transaction; re-importing an export never duplicates (matched on Category + Service Name + Gender)

### Database
- PostgreSQL schema in `database.pg.sql`: `admins`, `branches`, `categories`, `sub_categories`, `services`, `service_variants`, `service_branches`
- Idempotent migration script; `updated_at` maintained by triggers
- Connection pooling (max 10) with SSL for Neon; a compatibility layer translates MySQL-style `?` placeholders to Postgres `$n` and mimics the `[rows, meta]` result shape

### Error Handling
- Per-controller `try/catch` wrappers; unexpected errors log server-side and return a generic 500 — no SQL, stack traces or internals leak to clients
- Multer upload errors mapped to friendly 400 messages

## Tech Stack

Confirmed from `package.json`:

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| Framework | Express 4 |
| Database | PostgreSQL via `pg` — hosted on Neon, raw SQL, no ORM |
| Auth | `jsonwebtoken`, `bcryptjs` |
| Uploads | `multer`, AWS SDK for JavaScript v3 (Cloudflare R2) |
| Excel | `exceljs` |
| Config | `dotenv`, `cors` |
| Dev | `nodemon` |

There is **no** Delhivery/shipping integration, **no** cron/scheduled jobs, and **no** booking/order data model in the current codebase.

Cloudflare R2 is the only media storage integration — no Cloudinary SDK or Cloudinary API call remains in `src/`. Cloudinary appears only in `scripts/migrateMediaToR2.mjs` and `data/media-migration-manifest.json` (legacy-URL detection for the one-time migration; see [Cloudinary Migration and Legacy Media](#cloudinary-migration-and-legacy-media)).

## Architecture

```
Frontend (tnh-salon)
        │  fetch + JWT (NEXT_PUBLIC_API_URL)
        ▼
Express API (src/server.js)
        ▼
Controllers (src/controllers)      ← request validation + response shaping
        ▼
Services (src/services)            ← business logic (auth, Excel)
        ▼
Models (src/models)                ← raw SQL via src/config/database.js
        ├───────────────────────┐
        ▼                       ▼
PostgreSQL (Neon)         Cloudflare R2
```

## Project Structure

```
tnh-backend/
├── src/
│   ├── config/            # database.js (pg pool + compat layer)
│   ├── controllers/       # auth, service, category, branch, upload, catalog
│   ├── middleware/        # authMiddleware.js (JWT Bearer)
│   ├── models/            # raw SQL: Admin, Service, Category, Branch
│   ├── routes/            # Express routers per resource
│   ├── seed/              # adminSeeder.js
│   ├── services/          # authService, catalogExcelService
│   ├── database/          # migrate.js, seed.js
│   ├── utils/             # perfLog.js (dev-only API timing)
│   └── server.js          # entry point
├── data/                  # catalog-services.mjs, catalog-categories.mjs (seed source); media-migration-manifest.json (Cloudinary → R2 migration log)
├── scripts/               # seed, migration and test scripts (incl. migrateMediaToR2.mjs)
├── tests/                 # node:test suite (r2Media.test.js covers R2 storage + upload behaviour)
├── database.pg.sql        # canonical PostgreSQL schema
├── database.sql           # legacy MySQL schema (historical reference only)
├── package.json
└── .env.example
```

## API Endpoints

All routes verified against `src/routes`:

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Health check |
| POST | `/api/auth/login` | — | Admin login → `{ success, token, admin }` |
| GET | `/api/auth/me` | ✓ | Current admin profile |
| GET | `/api/services` | — | List services. Query: `search`, `category`, `subCategory`, `branch`, `audience`, `status`, `page`, `limit`, `sort`, `priceMin`, `priceMax` |
| GET | `/api/services/count` | — | Total active services (unfiltered integer) |
| GET | `/api/services/:id` | — | One service by numeric id or slug |
| POST | `/api/services` | ✓ | Create a service |
| PUT | `/api/services/:id` | ✓ | Update a service |
| PATCH | `/api/services/:id/status` | ✓ | Set status (`Active` / `Inactive`) |
| DELETE | `/api/services/:id` | ✓ | Delete a service |
| GET | `/api/categories` | — | List categories (with sub-categories) |
| GET | `/api/categories/:id` | — | One category by id or slug |
| POST | `/api/categories` | ✓ | Create a category (with sub-categories) |
| PUT | `/api/categories/:id` | ✓ | Update a category |
| PATCH | `/api/categories/:id/order` | ✓ | Reorder — body `{ "direction": "up" \| "down" }` |
| DELETE | `/api/categories/:id` | ✓ | Delete a category |
| GET | `/api/branches` | — | List branches |
| PUT | `/api/branches/:id` | ✓ | Update a branch profile |
| POST | `/api/upload/image` | ✓ | Upload image to R2 (multipart field `image`) |
| POST | `/api/upload/video` | ✓ | Upload video to R2 (multipart field `video`) |
| DELETE | `/api/upload/media` | ✓ | Delete an unreferenced R2 object (JSON `objectKey`) |
| GET | `/api/catalog/export` | ✓ | Download the catalogue as reference `.xlsx` |
| POST | `/api/catalog/import` | ✓ | Import a reference `.xlsx` (multipart field `file`, ≤ 10 MB) |
## Database

- **PostgreSQL**, hosted on [Neon](https://neon.tech) (serverless). Use the **pooled** connection string (`-pooler` host) for application traffic.
- Connection config: `src/config/database.js` — `pg.Pool` with `ssl`, `max: 10`, plus a small adapter that keeps MySQL-era call sites working (`?` → `$n` placeholders, `insertId` / `affectedRows` on results).

### Tables

| Table | Purpose |
|---|---|
| `admins` | Admin credentials (bcrypt `password_hash`), role, active flag |
| `branches` | Branch profiles (slug, contact, address, hours JSONB, map URLs) |
| `categories` | Service categories (slug, name, icon, image, display order) |
| `sub_categories` | Sub-categories belonging to a category (unique per `category_id` + `slug`) |
| `services` | Services (slug, category, sub-category, audience, pricing type/price/price range, duration, image, display order, active flag) |
| `service_variants` | Size/variant pricing rows per service |
| `service_branches` | Service ↔ branch availability (composite PK) |

There is no bookings, orders or customers table — the catalogue plus `admins`/`branches` is the entire schema.

## Database Migration

Migrations are handled by a single idempotent schema script:

- Schema source: `database.pg.sql` (all statements are `IF NOT EXISTS` / `CREATE OR REPLACE`, safe to re-run)
- Runner: `src/database/migrate.js`

```bash
npm run db:migrate
```

(Or directly with psql: `psql "$DATABASE_URL" -f database.pg.sql`.)

## Seed Data

Two seeders, both reading admin credentials from `ADMIN_*` env vars:

- `npm run seed:admin` — creates the first admin from `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` (bcrypt-hashed; skips if the email exists)
- `npm run seed:catalog` (alias `npm run seed`) — full catalogue sync. It imports the branches from `tnh-salon/src/data/branches.js` and the service/category data from `data/catalog-*.mjs`, **validates everything before touching the database**, then upserts branches, categories, sub-categories and services (with variants and branch links) inside a single transaction — any error rolls back everything. Services match on their stable slug, so re-running updates instead of duplicating; stale rows are reported but never auto-deleted. It also runs the migration first, so a fresh database can be seeded in one step.

## Environment Variables

Copy `.env.example` to `.env`. Names only — fill in your own values; never commit `.env`.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `5001` in `.env.example`, falls back to `5000`) |
| `DATABASE_URL` | Neon PostgreSQL connection string (pooled host, `sslmode=require`) |
| `JWT_SECRET` | Secret used to sign admin JWTs |
| `JWT_EXPIRES_IN` | Token lifetime (e.g. `1d`) |
| `CLIENT_URL` | Allowed CORS origin (frontend URL) |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Credentials for the admin seeder |
| `R2_ACCOUNT_ID` | Cloudflare account ID used for the S3-compatible API endpoint |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Server-side R2 credentials; scope these to the migration bucket |
| `R2_BUCKET_NAME` | Existing R2 bucket to receive migrated objects |
| `R2_PUBLIC_BASE_URL` | HTTPS public media domain (not the S3 API endpoint) |

## Cloudflare R2 Configuration

Cloudflare R2 is the active media storage provider for all catalogue media (bucket `tnh-service-media`). The five variables below are validated by `src/services/r2Storage.js` and are only required when an upload, deletion or migration operation is requested — the API can start without them.

| Variable | Purpose | Example (placeholder) |
|---|---|---|
| `R2_ACCOUNT_ID` | The bare 32-character Cloudflare account ID. Used to build the S3-compatible API endpoint `https://<account-id>.r2.cloudflarestorage.com`. An endpoint hostname (e.g. `<account>.r2.cloudflarestorage.com`) is rejected as invalid. | `00000000000000000000000000000000` |
| `R2_ACCESS_KEY_ID` | Access key ID of the R2 S3 API credentials (Cloudflare → R2 → **Manage API tokens**). Server-side only — never expose to the frontend. | `your_r2_access_key_id` |
| `R2_SECRET_ACCESS_KEY` | Secret access key of the same R2 S3 credentials. Secret — never commit it or add it to any `.env.example` value or frontend environment. | `your_r2_secret_access_key` |
| `R2_BUCKET_NAME` | Target bucket for all catalogue media (`tnh-service-media`). | `tnh-service-media` |
| `R2_PUBLIC_BASE_URL` | HTTPS public media base URL — either the bucket's r2.dev development domain or a custom domain. **Not** the S3 API endpoint; the bare S3 endpoint host is rejected. No query string, fragment or credentials. Currently configured as `https://pub-b918b81434db40679914292fe67c6d10.r2.dev`. | `https://pub-00000000000000000000000000000000.r2.dev` |

The backend also accepts and validates stricter details: object keys must sit under `categories/`, `services/`, `migration/categories/` or `migration/services/`; images are stored with `Cache-Control: public, max-age=31536000, immutable` and a `sha256` metadata hash used for end-to-end verification.

### Setup

1. **Create/configure the bucket** — Cloudflare dashboard → **R2 → Create bucket** (`tnh-service-media`). Uploads from the app are written to `categories/…` and `services/…`; the migration CLI writes to `migration/categories/…` and `migration/services/…`.
2. **S3-compatible credentials** — Cloudflare dashboard → R2 → **Manage API tokens** → create an API credential scoped to the bucket; copy its access key ID and secret into `.env` only, never into the committed `.env.example` or the frontend environment.
3. **Public media URL** — in the bucket's **Settings → Public access**, either allow the r2.dev development domain (gives a URL like `https://pub-<hex>.r2.dev`) or attach a custom domain. Set that HTTPS origin (no path suffix, no query string) as `R2_PUBLIC_BASE_URL`.
4. **Add the variables to `.env`** — copy `.env.example` to `.env` and fill in the five `R2_*` values above alongside `PORT`, `DATABASE_URL`, `JWT_*`, `CLIENT_URL` and `ADMIN_*`. Set `NEXT_PUBLIC_R2_PUBLIC_BASE_URL` in the **frontend** build environment to the same public media domain; that variable is public and contains no credentials.
5. **Start and test the backend** — `npm run dev` (or `npm start`), then check `GET /health`, log in, and exercise an upload from the admin panel.
6. **Verify an uploaded object's public URL** — the upload endpoint already verifies every object before responding: after a `PutObject` it runs `HEAD`/`GET` inside the bucket and a public fetch of the returned URL, checking byte length, Content-Type and SHA-256 (videos additionally require HTTP range-request support). Independently confirm delivery with:

```sh
curl -I "<public-url-returned-by-the-upload>"
# expect HTTP 200 with content-type matching the file (image/jpeg, video/mp4, …)
```

### Uploaded media persistence and replacement cleanup

- The upload endpoints return `{ imageUrl, mediaUrl, publicId, objectKey, mediaType }`; `publicId`/`objectKey` are the R2 object key (`type/slug/<sha256(content)>.<ext>`).
- Detected signatures also **correct the file extension**: for images, the object key extension is rewritten from the sniffed Content-Type (e.g. a JPEG named `nails-009.webp` is stored as an `image/jpeg` object ending in `.jpg`); videos keep their original extension.
- `categoryController.js` and `serviceController.js` persist the returned URL into the catalogue columns — `image` / `image_url` on both `categories` and `services` — from the create/update payloads (`body.image` / `body.imageUrl`).
- When an update or delete changes the media URL, `deleteReplacedR2Media` deletes the previous **R2** object only after confirming no `categories`/`services` row still references its URL — and only for URLs that map onto the configured R2 media domain. Legacy Cloudinary URLs never map, so they are never touched by this cleanup.
- `DELETE /api/upload/media` enforces the same reference rule directly: it returns `409` when the object's public URL is still referenced by a category or service.

## Cloudinary Migration and Legacy Media

The database is no longer seeded by the migration runner — existing legacy
media may still reference **Cloudinary** URLs in Neon PostgreSQL. Re-pointing a
record requires its media to exist and be verified in R2 first; the underlying
Cloudinary files do **not** automatically move to R2 unless they are explicitly
mapped and migrated. The migration workflow and status follow.

`npm run media:prepare` reads current Neon media references and local media
filenames into `data/media-migration-manifest.json`. It does not contact the
source provider or write to Neon. The manifest is the rollback/audit record and
must be backed up securely because it contains existing media URLs.

Only explicitly mapped replacement files are eligible for upload. Prepare a
JSON file mapping each `assetId` to a verified replacement source file path:

```json
{
  "ASSET_ID_FROM_MANIFEST": "/absolute/path/to/verified-replacement.webp"
}
```

The filename index in the manifest is for discovery only and does not
automatically authorize a source file. Map every source explicitly after
confirming it is the intended media; a matching filename alone does not prove
the bytes are the correct replacement. Source map keys may be an `assetId` or
an exact original URL from the manifest.

Validate the source mapping and calculate keys/hashes without uploading or
changing Neon:

```sh
npm run media:migrate -- --dry-run --source-map /secure/path/media-map.json
```

After reviewing the manifest and dry-run output, upload each mapped file,
verify R2 object bytes and public delivery, and then update only the matching
media URL fields:

```sh
npm run media:migrate -- --source-map /secure/path/media-map.json
```

To restore original database URLs from the manifest (R2 objects are retained):

```sh
npm run media:rollback
```

The migration leaves unmapped records unchanged and marks them as needing a
replacement. It does not substitute unrelated static media or clear media
fields. Take a database backup and review every mapped asset before running
against production.

#### Status and limitations (verified from the manifest)

- As of the latest `data/media-migration-manifest.json` generation: **235
  distinct Cloudinary assets are still referenced by live `categories`/`services`
  records, no local source file matched any of them, and 235 replacement files
  are still needed** — every asset is currently in `migrationStatus:
  "needs-replacement"`.
- `databaseModified: false` — the migration scripts have not rewritten any
  database media URL and no live R2-verified migration of legacy assets has
  taken place. Do not assume otherwise.
- The Cloudinary Admin API and public asset requests were unavailable
  (HTTP 401) during preparation, so **no source bytes could be downloaded from
  Cloudinary** — source files must come from a verified replacement mapping.
- Only explicitly mapped replacement files are eligible for upload. The mapped
  file must be verified (it is genuinely the intended media, matching the
  image/video type) and uploaded to R2 with verification before any database
  record is re-pointed.

## Security

Actually implemented:

- JWT-based admin auth; passwords hashed with bcrypt (10 rounds)
- Generic auth failures that don't reveal whether an email exists
- Strict CORS allow-list (`CLIENT_URL` origin, `credentials: true`)
- JWT middleware on all mutating/admin routes
- Upload restrictions (file size, MIME type, folder whitelist)
- Server-side only secrets (`.env` git-ignored); database credentials never reach the client
- Error sanitization — controllers return generic messages; no SQL or stack traces leak out

**Not implemented** (do not assume otherwise): rate limiting, request body schema validation libraries, HTTPS termination (handled by the hosting platform), refresh tokens.

## Error Handling

Status codes actually returned by the code:

| Code | When |
|---|---|
| `400` | Invalid input (login fields, media file, status value, invalid import file) |
| `401` | Missing/invalid/expired Bearer token; invalid login credentials |
| `404` | Unknown route, service, category or branch |
| `409` | Duplicate category name/slug on create; deletion of a media object still referenced by `categories` or `services` |
| `500` | Unexpected server error (generic message) |
| `502` | R2 media upload or deletion failure |
| `503` | R2 media operation requested while R2 configuration is missing or invalid (`code: "R2_NOT_CONFIGURED"`) |

## Running Locally

```bash
npm install
npm run db:migrate     # create the schema (idempotent)
npm run seed:admin     # first admin from ADMIN_* env vars
npm run seed:catalog   # optional: full catalogue from data files
npm run dev            # nodemon, http://localhost:5001
```

Production:

```bash
npm start              # node src/server.js
```

Maintenance scripts in `scripts/`:

- `scripts/backfillServiceSubCategories.mjs` — one-off sub-category backfill helper
- `scripts/test-reference-file.mjs <file.xlsx>` — validates an Excel file against the import pipeline without writing to the database
- `scripts/test-roundtrip.mjs` — exercises export/import end-to-end against a running server
- `scripts/migrateMediaToR2.mjs` — Cloudinary → R2 media migration CLI (`npm run media:prepare` / `media:migrate` / `media:rollback`); writes the audit manifest `data/media-migration-manifest.json`, uploads with verification, and updates `categories`/`services` media URL fields transactionally
- `npm test` — node:test suite (`tests/*.test.js`); `tests/r2Media.test.js` covers R2 configuration validation, object-key scoping, upload verification and public-URL mapping

## Production

The backend is designed to run as a plain Node process (`npm start`) with a PostgreSQL/Neon `DATABASE_URL` and platform-provided environment variables. **No deployment configuration file is present in the repository** — the specific hosting platform is not confirmed from the current codebase.

## Troubleshooting

- **`Failed to connect to the database`** — `DATABASE_URL` is missing/wrong, or Neon is unreachable. Use the pooled connection string and keep `sslmode=require`. The process exits on startup failure by design.
- **Frontend can't reach the API (CORS)** — `CLIENT_URL` must exactly match the frontend origin (protocol + domain + port — the frontend dev server runs at `http://localhost:3000`). Restart after changing `.env`.
- **Admin login always fails with 401** — no admin seeded (`npm run seed:admin`) or `JWT_SECRET` differs between runs. `ADMIN_NAME/EMAIL/PASSWORD` must be set before seeding.
- **Image/video upload returns 400** — file over 5 MB (image) or 250 MB (video), unsupported extension, or `type` not in `categories`/`services`. An upload whose **contents don't match the extension** also returns 400 — the backend sniffs magic numbers (`jpeg/png/gif/webp/avif` for images, `ftyp`/EBML for video) and rejects renamed files (e.g. a JPEG named `.webp`) with "File contents do not match the … format."
- **Video upload returns 400 "Video size is too large."** — multipart body exceeds the 250 MB limit enforced by multer on `POST /api/upload/video`.
- **Upload returns 503 with `code: "R2_NOT_CONFIGURED"`** — R2 configuration is missing or invalid. The response's `missingConfiguration` / `invalidConfiguration` arrays name the offending variables. Common mistakes: an endpoint hostname in `R2_ACCOUNT_ID` (must be the bare 32-character account ID, e.g. 32 lowercase hex characters) and the S3 API endpoint in `R2_PUBLIC_BASE_URL` (must be the HTTPS public media domain, e.g. `https://pub-…r2.dev` or a custom domain). Fix `.env` and restart the backend. The server itself will still start — the error surfaces on the first media operation.
- **Upload returns 502 `R2_UPLOAD_FAILED`** — R2 rejected the object or the verification round-trip failed. Check the credentials (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` validity), bucket permissions (the token must be able to `PutObject`/`HeadObject`/`GetObject`/`DeleteObject` on the mapped prefixes) and the failure diagnostics in the server log (`R2 media upload failed.` with the verification stage, HTTP status, and bounded failure reason). These diagnostics never include credential values.
- **Upload succeeds (201) but the object is unavailable at its public URL** — `R2_PUBLIC_BASE_URL` doesn't match the URL that actually serves the bucket. If you use the r2.dev development domain, confirm public access is enabled for the bucket; if you use a custom domain, confirm the domain is attached and DNS-served. Note the upload pipeline verifies the public URL via `HEAD`/`GET` before returning 201 — a 201 means the configured domain was reachable and byte-verified at upload time; later failures are typically access-disabled buckets, DNS or domain changes. Also keep `NEXT_PUBLIC_R2_PUBLIC_BASE_URL` in the frontend build in sync with this URL.
- **Import fails validation** — open the returned `errors` array (also shown in the admin UI); nothing was written because validation precedes the transaction.
- **Migration re-run does nothing / is safe** — every statement in `database.pg.sql` is idempotent; re-running never drops data. Migration runs of `media:migrate` also re-verify mapped sources; previously-verified R2 destinations are reused without re-upload.
