# The Nail Hue — Backend

Node.js + Express REST API powering The Nail Hue salon website (`tnh-salon`) and its admin panel. It serves the service catalogue and branches, handles admin authentication, image uploads, Excel catalogue import/export, and proxies the AI assistant to the Cheerio AI Agent.

## Overview

- **Public API** — services catalogue (with filters, search, pagination), categories/sub-categories, branches, AI assistant chat.
- **Admin API** — JWT-protected CRUD for services and categories, branch updates, Cloudinary image uploads, and reference-format Excel export/import of the catalogue.
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

### AI Agent
- `POST /api/ai-agent/interact` — validates input, forwards `{ question, history, collectedData }` to the **Cheerio AI Agent** and returns a mapped response
- Response mapping returns `answer`, `answers`, `quickReplies`, `context`, `collectedData`, `products`; internal `tokenUsage` is intentionally stripped
- **Timeout handling**: 15s `AbortController` timeout → `504`; Cheerio 429 → `429`; other failures → `502`
- The Cheerio API key never leaves the server process

### Uploads
- `POST /api/upload/image` — admin-only image upload to **Cloudinary** (5 MB max, `image/*` only, folder whitelist: `categories`, `services`)

### Catalogue Import / Export
- `GET /api/catalog/export` — streams the live catalogue as a reference-format `.xlsx` (ExcelJS; 2 sheets, 17 service columns)
- `POST /api/catalog/import` — validates the entire workbook **before** any database change, then applies it in a single transaction; re-importing an export never duplicates (matched on Category + Service Name + Gender)

### Database
- PostgreSQL schema in `database.pg.sql`: `admins`, `branches`, `categories`, `sub_categories`, `services`, `service_variants`, `service_branches`
- Idempotent migration script; `updated_at` maintained by triggers
- Connection pooling (max 10) with SSL for Neon; a compatibility layer translates MySQL-style `?` placeholders to Postgres `$n` and mimics the `[rows, meta]` result shape

### Error Handling
- Per-controller `try/catch` wrappers; unexpected errors log server-side and return a generic 500 — no SQL, stack traces or internals leak to clients
- AI controller maps external failures to `400` (validation), `429` (upstream rate limit), `502` (upstream error), `504` (upstream timeout)
- Multer upload errors mapped to friendly 400 messages

## Tech Stack

Confirmed from `package.json`:

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| Framework | Express 4 |
| Database | PostgreSQL via `pg` — hosted on Neon, raw SQL, no ORM |
| Auth | `jsonwebtoken`, `bcryptjs` |
| Uploads | `multer`, `cloudinary` |
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
Services (src/services)            ← business logic (auth, Cheerio, Excel)
        ▼
Models (src/models)                ← raw SQL via src/config/database.js
        ▼
PostgreSQL (Neon)        External: Cheerio AI Agent, Cloudinary
```

## Project Structure

```
tnh-backend/
├── src/
│   ├── config/            # database.js (pg pool + compat layer), cloudinary.js
│   ├── controllers/       # auth, service, category, branch, upload, catalog, aiAgent
│   ├── middleware/        # authMiddleware.js (JWT Bearer)
│   ├── models/            # raw SQL: Admin, Service, Category, Branch
│   ├── routes/            # Express routers per resource
│   ├── seed/              # adminSeeder.js
│   ├── services/          # authService, cheerioAiService, catalogExcelService
│   ├── database/          # migrate.js, seed.js
│   ├── utils/             # perfLog.js (dev-only API timing)
│   └── server.js          # entry point
├── data/                  # catalog-services.mjs, catalog-categories.mjs (seed source)
├── scripts/               # seedCatalog.mjs, backfillServiceSubCategories.mjs, test-*.mjs
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
| POST | `/api/upload/image` | ✓ | Upload image to Cloudinary (multipart field `image`) |
| GET | `/api/catalog/export` | ✓ | Download the catalogue as reference `.xlsx` |
| POST | `/api/catalog/import` | ✓ | Import a reference `.xlsx` (multipart field `file`, ≤ 10 MB) |
| POST | `/api/ai-agent/interact` | — | AI assistant proxy to Cheerio (see below) |

### AI Agent endpoint

`POST /api/ai-agent/interact`

Request:

```json
{
  "question": "Do you do gel extensions?",
  "history": [{ "role": "user", "content": "Hi" }],
  "collectedData": {}
}
```

Validation: `question` is a required non-empty string, `history` must be an array, `collectedData` must be an object — otherwise `400`.

Response (200):

```json
{
  "success": true,
  "answer": "…",
  "answers": ["…"],
  "quickReplies": ["…"],
  "context": [],
  "collectedData": {},
  "products": []
}
```

Architecture:

```
TNH Frontend
      │  POST /api/ai-agent/interact
      ▼
TNH Backend ── (x-api-key, server-side only) ──▶  Cheerio AI Agent
      ▲                                              │
      └────────────── mapped JSON response ──────────┘
```

The Cheerio credential (`CHEERIO_AI_API_KEY`) is read only inside `src/services/cheerioAiService.js` and is never sent to the frontend. Requests abort after 15 seconds.

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
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Cloudinary upload credentials |
| `CLOUDINARY_FOLDER` | Root Cloudinary folder (default `tnh-salon`) |
| `CHEERIO_AI_API_URL` | Cheerio AI Agent endpoint URL |
| `CHEERIO_AI_API_KEY` | Cheerio API key — **server-side only**, never exposed to the frontend |

## Security

Actually implemented:

- JWT-based admin auth; passwords hashed with bcrypt (10 rounds)
- Generic auth failures that don't reveal whether an email exists
- Strict CORS allow-list (`CLIENT_URL` origin, `credentials: true`)
- JWT middleware on all mutating/admin routes; the AI endpoint is public but input-validated
- Upload restrictions (file size, MIME type, folder whitelist)
- Server-side only secrets (`.env` git-ignored); the Cheerio key and database credentials never reach the client
- Error sanitization — controllers return generic messages; no SQL, stack traces or `tokenUsage` leak out

**Not implemented** (do not assume otherwise): rate limiting, request body schema validation libraries, HTTPS termination (handled by the hosting platform), refresh tokens.

## Error Handling

Status codes actually returned by the code:

| Code | When |
|---|---|
| `400` | Invalid input (login fields, AI payload, image file, status value, invalid import file) |
| `401` | Missing/invalid/expired Bearer token; invalid login credentials |
| `404` | Unknown route, service, category or branch |
| `409` | Duplicate category name/slug on create |
| `429` | Cheerio upstream rate limit |
| `500` | Unexpected server error (generic message) |
| `502` | Cloudinary upload failure; Cheerio upstream error |
| `504` | Cheerio request timeout (15s) |

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
- **`Cheerio AI Agent is not configured`** — `CHEERIO_AI_API_URL` / `CHEERIO_AI_API_KEY` missing in `.env`; the AI widget will surface a 502.
- **Image upload returns 400** — file over 5 MB, non-image MIME type, or `type` not in `categories`/`services`.
- **Import fails validation** — open the returned `errors` array (also shown in the admin UI); nothing was written because validation precedes the transaction.
- **Migration re-run does nothing / is safe** — every statement in `database.pg.sql` is idempotent; re-running never drops data.
