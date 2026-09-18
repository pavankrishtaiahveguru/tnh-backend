# TNH Backend

API server for The Nail Hue salon site (public catalogue) and its admin panel.

## Tech Stack

- Node.js + Express
- PostgreSQL ([Neon](https://neon.tech), serverless Postgres)
- Raw SQL via [`pg`](https://node-postgres.com/) — no ORM
- JWT-based admin authentication (`jsonwebtoken`, `bcryptjs`)
- Cloudinary for image uploads
- ExcelJS for the service catalogue import/export

## Environment Variables

Copy `.env.example` to `.env` and fill in real values. `.env` is git-ignored and must never be committed.

```
PORT=5001
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require"
JWT_SECRET=...
JWT_EXPIRES_IN=7d
CLIENT_URL=http://localhost:3000
ADMIN_NAME=...
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
CLOUDINARY_FOLDER=tnh-salon
```

`DATABASE_URL` is the only database-related variable — use Neon's **pooled** connection string (hostname contains `-pooler`) for normal application traffic. The database is only ever reachable from this backend; the frontend never sees a connection string.

## Local Development

```bash
npm install
npm run db:migrate   # creates/updates the schema (idempotent)
npm run seed:admin   # creates the first admin from ADMIN_* env vars
npm run seed:catalog # (optional) loads the reference catalogue from tnh-salon's data files
npm run dev           # nodemon, http://localhost:5001
```

Other scripts:
- `npm start` — production start (no nodemon)
- `node scripts/test-reference-file.mjs <file.xlsx>` — validates a reference Excel file against the import pipeline without writing to the database
- `node scripts/test-roundtrip.mjs` — exercises the live backend's export/import cycle end-to-end (requires the server running)

## Database Setup (Neon)

1. Create a Neon project and database.
2. Copy the pooled Postgres connection string from the Neon dashboard.
3. Set it as `DATABASE_URL` in `.env`.
4. Run `npm run db:migrate` to create the schema (see `database.pg.sql`).
5. Run `npm run seed:admin` (and `npm run seed:catalog` if you need the reference catalogue) to populate data.
6. Start the backend with `npm run dev` or `npm start`.

## Migration Notes (MySQL → PostgreSQL / Neon)

This backend originally used `mysql2` with hand-written raw SQL (no ORM). It has been migrated to PostgreSQL (Neon), keeping the same raw-SQL architecture:

- `src/config/database.js` now wraps `pg` instead of `mysql2`. It translates the existing `?`-style placeholders to Postgres's `$1, $2, ...` syntax and mimics mysql2's `[rows, meta]` return shape (`insertId`, `affectedRows`) so the model/controller/service layers did not need per-query rewrites.
- `database.pg.sql` is the canonical Postgres schema (`AUTO_INCREMENT` → `SERIAL`, `ENUM` → `VARCHAR` + `CHECK`, `JSON` → `JSONB`, `ON UPDATE CURRENT_TIMESTAMP` → a `set_updated_at()` trigger, inline `INDEX`/`ENGINE`/`CHARSET` clauses removed in favor of standalone `CREATE INDEX` statements). `npm run db:migrate` applies it and is safe to re-run.
- MySQL-only SQL was rewritten: `ON DUPLICATE KEY UPDATE` → `INSERT ... ON CONFLICT (...) DO UPDATE SET ... = EXCLUDED...`, `INSERT IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`, and the one `REGEXP_REPLACE`-based match key (catalogue import) was moved into JS so both sides of that comparison share one normalization function instead of relying on MySQL regex semantics.
- `TINYINT(1)`/integer boolean flags (`1`/`0`) became native `BOOLEAN` values (`true`/`false`).
- The old `database.sql` (MySQL DDL) is kept only as historical reference; `database.pg.sql` is the source of truth going forward.
- There is no booking/enquiry/customer data model in this project — the catalogue (`categories`, `sub_categories`, `services`, `service_variants`, `service_branches`) and `admins`/`branches` are the entire schema.

## API

All responses are JSON: `{ success, message?, data?, errors? }`. Routes under auth middleware require `Authorization: Bearer <token>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Health check |
| POST | `/api/auth/login` | — | Admin login, returns a JWT |
| GET | `/api/auth/me` | ✓ | Current admin profile |
| GET | `/api/services` | — | List services (filters: `search`, `category`, `subCategory`, `branch`, `audience`, `status`) |
| GET | `/api/services/:id` | — | Get one service (by id or slug) |
| POST | `/api/services` | ✓ | Create a service |
| PUT | `/api/services/:id` | ✓ | Update a service |
| PATCH | `/api/services/:id/status` | ✓ | Set Active/Inactive |
| DELETE | `/api/services/:id` | ✓ | Delete a service |
| GET | `/api/categories` | — | List categories (with sub-categories, service counts) |
| GET | `/api/categories/:id` | — | Get one category |
| POST | `/api/categories` | ✓ | Create a category |
| PUT | `/api/categories/:id` | ✓ | Update a category |
| PATCH | `/api/categories/:id/order` | ✓ | Reorder (`direction: "up" | "down"`) |
| DELETE | `/api/categories/:id` | ✓ | Delete a category |
| GET | `/api/branches` | — | List branches |
| PUT | `/api/branches/:id` | ✓ | Update a branch |
| POST | `/api/upload/image` | ✓ | Upload an image to Cloudinary |
| GET | `/api/catalog/export` | ✓ | Export the full catalogue as the reference `.xlsx` (2 sheets, 17 columns) |
| POST | `/api/catalog/import` | ✓ | Import/update the catalogue from the reference `.xlsx` (matches on Category + Service Name + Gender, single transaction) |
