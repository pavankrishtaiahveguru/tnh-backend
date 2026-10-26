# The Nail Hue — Backend

Node.js + Express REST API powering The Nail Hue salon website (`tnh-salon`) and its admin panel. It serves the service catalogue and branches, handles admin authentication, image uploads, and Excel catalogue import/export.

## Overview

- **Public API** — services catalogue (with filters, search, pagination), categories/sub-categories, branches.
- **Admin API** — JWT-protected CRUD for services and categories, branch updates, Cloudflare R2 media uploads, and reference-format Excel export/import of the catalogue.
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
- `DELETE /api/upload/media` — admin-only deletion of an unreferenced R2 object

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
├── data/                  # catalog-services.mjs, catalog-categories.mjs (seed source)
├── scripts/               # seed, migration and test scripts
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

### Cloudflare R2 media storage

Admin uploads use the authenticated `/api/upload/image` and `/api/upload/video`
routes. R2 configuration is checked only when an upload/delete/migration
operation is requested; the backend and unrelated API routes can start without
R2 credentials. Image uploads are limited to 5 MB and videos to 250 MB.
Uploads are content-sniffed, assigned collision-resistant content-addressed
keys, and checked against R2 plus the configured public HTTPS domain. Video
public delivery is checked for byte-range support.

Set the five `R2_*` values in the backend's local `.env` and production
environment. Set `NEXT_PUBLIC_R2_PUBLIC_BASE_URL` in the frontend build
environment to the same HTTPS public domain; this value is public and contains
no credentials. The frontend accepts remote database media only from this
configured domain and retains relative `/public` asset paths.

### Existing media migration

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
| `400` | Invalid input (login fields, image file, status value, invalid import file) |
| `401` | Missing/invalid/expired Bearer token; invalid login credentials |
| `404` | Unknown route, service, category or branch |
| `409` | Duplicate category name/slug on create |
| `500` | Unexpected server error (generic message) |
| `502` | R2 media upload or deletion failure |

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

## Production

The backend is designed to run as a plain Node process (`npm start`) with a PostgreSQL/Neon `DATABASE_URL` and platform-provided environment variables. **No deployment configuration file is present in the repository** — the specific hosting platform is not confirmed from the current codebase.

## Troubleshooting

- **`Failed to connect to the database`** — `DATABASE_URL` is missing/wrong, or Neon is unreachable. Use the pooled connection string and keep `sslmode=require`. The process exits on startup failure by design.
- **Frontend can't reach the API (CORS)** — `CLIENT_URL` must exactly match the frontend origin (protocol + domain + port). Restart after changing `.env`.
- **Admin login always fails with 401** — no admin seeded (`npm run seed:admin`) or `JWT_SECRET` differs between runs. `ADMIN_NAME/EMAIL/PASSWORD` must be set before seeding.
- **Image upload returns 400** — file over 5 MB, non-image MIME type, or `type` not in `categories`/`services`.
- **Import fails validation** — open the returned `errors` array (also shown in the admin UI); nothing was written because validation precedes the transaction.
- **Migration re-run does nothing / is safe** — every statement in `database.pg.sql` is idempotent; re-running never drops data.
