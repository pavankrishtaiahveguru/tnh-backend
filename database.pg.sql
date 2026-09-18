-- ==================================================
-- TNH Salon - Database Setup (PostgreSQL / Neon)
-- Run via:
--   psql "$DATABASE_URL" -f database.pg.sql
-- or (idempotent, same statements) via:
--   npm run db:migrate
-- ==================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ==================================================
-- Admins (backend-only credentials; bcrypt password_hash)
-- ==================================================
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'admin',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_admins_updated_at ON admins;
CREATE TRIGGER trg_admins_updated_at BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==================================================
-- Branches (Indiranagar / Sarjapur Road)
-- ==================================================
CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(30) NULL,
  email VARCHAR(255) NULL,
  address VARCHAR(255) NULL,
  map_url VARCHAR(500) NULL,
  map_embed_url TEXT NULL,
  title VARCHAR(255) NULL,
  subtitle VARCHAR(255) NULL,
  hours JSONB NULL,
  about_title VARCHAR(255) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_branches_updated_at ON branches;
CREATE TRIGGER trg_branches_updated_at BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==================================================
-- Categories
-- ==================================================
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(120) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  description TEXT NULL,
  icon VARCHAR(60) NULL,
  image VARCHAR(500) NULL,
  image_url VARCHAR(500) NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_categories_updated_at ON categories;
CREATE TRIGGER trg_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==================================================
-- Sub-categories (belong to a category)
-- ==================================================
CREATE TABLE IF NOT EXISTS sub_categories (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE ON UPDATE CASCADE,
  slug VARCHAR(120) NOT NULL,
  name VARCHAR(150) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_subcategory_category_slug UNIQUE (category_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_sub_categories_category ON sub_categories(category_id);

DROP TRIGGER IF EXISTS trg_sub_categories_updated_at ON sub_categories;
CREATE TRIGGER trg_sub_categories_updated_at BEFORE UPDATE ON sub_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==================================================
-- Services
-- ==================================================
CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(160) NOT NULL UNIQUE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  sub_category_id INTEGER NULL REFERENCES sub_categories(id) ON DELETE SET NULL ON UPDATE CASCADE,
  name VARCHAR(200) NOT NULL,
  audience VARCHAR(50) NOT NULL DEFAULT 'Unisex',
  description TEXT NULL,
  pricing_type VARCHAR(20) NOT NULL DEFAULT 'fixed'
    CHECK (pricing_type IN ('fixed', 'size', 'variant', 'from')),
  price DECIMAL(10, 2) NULL,
  price_range VARCHAR(60) NULL,
  duration VARCHAR(60) NULL,
  image VARCHAR(500) NULL,
  image_url VARCHAR(500) NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NULL,
  good_to_know TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_services_category ON services(category_id);
CREATE INDEX IF NOT EXISTS idx_services_sub_category ON services(sub_category_id);
CREATE INDEX IF NOT EXISTS idx_services_audience ON services(audience);
CREATE INDEX IF NOT EXISTS idx_services_active ON services(is_active);
-- Covers the public Services page's default ordering (display_order, name)
-- so Postgres can satisfy ORDER BY + LIMIT from the index instead of a sort.
CREATE INDEX IF NOT EXISTS idx_services_display_order_name
  ON services(display_order, name);
-- Trailing-index coverage for branch filtering via service_branches
-- (branch_id index exists; this adds the reverse direction used by EXISTS
-- lookups per service when the planner prefers service_id leading).
CREATE INDEX IF NOT EXISTS idx_service_branches_service_branch
  ON service_branches(service_id, branch_id);

DROP TRIGGER IF EXISTS trg_services_updated_at ON services;
CREATE TRIGGER trg_services_updated_at BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==================================================
-- Service pricing variants (size-based / custom variants)
-- ==================================================
CREATE TABLE IF NOT EXISTS service_variants (
  id SERIAL PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE ON UPDATE CASCADE,
  label VARCHAR(100) NOT NULL,
  price DECIMAL(10, 2) NOT NULL DEFAULT 0,
  duration VARCHAR(60) NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_variants_service ON service_variants(service_id);

-- ==================================================
-- Service <-> Branch availability (branch-aware services)
-- A row here means the service is offered at that branch.
-- Services available at BOTH branches have two rows.
-- ==================================================
CREATE TABLE IF NOT EXISTS service_branches (
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE ON UPDATE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (service_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_service_branches_branch ON service_branches(branch_id);

-- ==================================================
-- Seed data — branches (slugs match the admin panel IDs)
-- ==================================================
INSERT INTO branches (slug, name) VALUES
  ('indiranagar', 'Indiranagar'),
  ('sarjapur-road', 'Sarjapur Road')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;
