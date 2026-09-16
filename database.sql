-- ==================================================
-- TNH Salon - Database Setup
-- Run this file in MySQL Workbench (or via mysql CLI):
--   mysql -u root -p < database.sql
-- ==================================================

CREATE DATABASE IF NOT EXISTS tnh_salon
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE tnh_salon;

-- ==================================================
-- Admins (backend-only credentials; bcrypt password_hash)
-- ==================================================
CREATE TABLE IF NOT EXISTS admins (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'admin',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================================================
-- Branches (Indiranagar / Sarjapur Road)
-- ==================================================
CREATE TABLE IF NOT EXISTS branches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(30) NULL,
  email VARCHAR(255) NULL,
  address VARCHAR(255) NULL,
  map_url VARCHAR(500) NULL,
  map_embed_url TEXT NULL,
  title VARCHAR(255) NULL,
  subtitle VARCHAR(255) NULL,
  hours JSON NULL,
  about_title VARCHAR(255) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================================================
-- Categories
-- ==================================================
CREATE TABLE IF NOT EXISTS categories (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(120) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  description TEXT NULL,
  icon VARCHAR(60) NULL,
  image VARCHAR(500) NULL,
  image_url VARCHAR(500) NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================================================
-- Sub-categories (belong to a category)
-- ==================================================
CREATE TABLE IF NOT EXISTS sub_categories (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category_id INT UNSIGNED NOT NULL,
  slug VARCHAR(120) NOT NULL,
  name VARCHAR(150) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_subcategory_category_slug (category_id, slug),
  INDEX idx_sub_categories_category (category_id),
  CONSTRAINT fk_sub_categories_category
    FOREIGN KEY (category_id) REFERENCES categories(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================================================
-- Services
-- ==================================================
CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(160) NOT NULL UNIQUE,
  category_id INT UNSIGNED NOT NULL,
  sub_category_id INT UNSIGNED NULL,
  name VARCHAR(200) NOT NULL,
  audience VARCHAR(50) NOT NULL DEFAULT 'Unisex',
  description TEXT NULL,
  pricing_type ENUM('fixed', 'size', 'variant', 'from') NOT NULL DEFAULT 'fixed',
  price DECIMAL(10, 2) NULL,
  price_range VARCHAR(60) NULL,
  duration VARCHAR(60) NULL,
  image VARCHAR(500) NULL,
  image_url VARCHAR(500) NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NULL,
  good_to_know TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_services_category (category_id),
  INDEX idx_services_sub_category (sub_category_id),
  INDEX idx_services_audience (audience),
  INDEX idx_services_active (is_active),
  CONSTRAINT fk_services_category
    FOREIGN KEY (category_id) REFERENCES categories(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_services_sub_category
    FOREIGN KEY (sub_category_id) REFERENCES sub_categories(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================================================
-- Service pricing variants (size-based / custom variants)
-- ==================================================
CREATE TABLE IF NOT EXISTS service_variants (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  service_id INT UNSIGNED NOT NULL,
  label VARCHAR(100) NOT NULL,
  price DECIMAL(10, 2) NOT NULL DEFAULT 0,
  duration VARCHAR(60) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_service_variants_service (service_id),
  CONSTRAINT fk_service_variants_service
    FOREIGN KEY (service_id) REFERENCES services(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================================================
-- Service <-> Branch availability (branch-aware services)
-- A row here means the service is offered at that branch.
-- Services available at BOTH branches have two rows.
-- ==================================================
CREATE TABLE IF NOT EXISTS service_branches (
  service_id INT UNSIGNED NOT NULL,
  branch_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (service_id, branch_id),
  INDEX idx_service_branches_branch (branch_id),
  CONSTRAINT fk_service_branches_service
    FOREIGN KEY (service_id) REFERENCES services(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_service_branches_branch
    FOREIGN KEY (branch_id) REFERENCES branches(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================================================
-- Seed data — branches (slugs match the admin panel IDs)
-- ==================================================
INSERT INTO branches (slug, name) VALUES
  ('indiranagar', 'Indiranagar'),
  ('sarjapur-road', 'Sarjapur Road')
ON DUPLICATE KEY UPDATE name = VALUES(name);
