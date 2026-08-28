CREATE TABLE customer (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  tax_number VARCHAR(50),
  fiscal_code VARCHAR(50),
  email VARCHAR(255),
  phone_number VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT true,
  organization_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL,
  updated_by INT
);

CREATE TABLE product (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid CHAR(36) NOT NULL DEFAULT (UUID()),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  weight DOUBLE,
  tags JSON,
  metadata JSON,
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customer_order (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  order_date DATE NOT NULL DEFAULT (CURRENT_DATE),
  delivery_time TIME,
  total DECIMAL(12, 2) NOT NULL,
  notes TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  items JSON NOT NULL DEFAULT (JSON_ARRAY()),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL,
  FOREIGN KEY (customer_id) REFERENCES customer(id)
);

-- Composite primary key (product_id, lang) — translations-style table
CREATE TABLE product_translation (
  product_id INT NOT NULL,
  lang VARCHAR(8) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  PRIMARY KEY (product_id, lang),
  FOREIGN KEY (product_id) REFERENCES product(id)
);

-- Unique parent of customer (via customer.organization_id, no DB-level FK on purpose).
-- Enables combining a unique joinLeft and a multiple joinGroup on the same main table
-- (see test/integration/agg-orderby-joinleft.test.js).
CREATE TABLE organization (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  city VARCHAR(255)
);

-- betterauth-style table: camelCase column names (backtick-quoted in MySQL preserves case)
CREATE TABLE `userAccount` (
  `id` VARCHAR(64) PRIMARY KEY,
  `userId` VARCHAR(64) NOT NULL,
  `providerId` VARCHAR(50) NOT NULL,
  `accountId` VARCHAR(255) NOT NULL,
  `accessToken` TEXT,
  `createdAt` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` TIMESTAMP NULL
);

-- A row owned by two parties, visible to either: the shape `tenantScope: { anyOf: [...] }`
-- exists for. Both owner columns are nullable on purpose — a NULL party must not match, and
-- must not stop the other party from matching.
CREATE TABLE shift_swap_request (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_id INT,
  requester_agent_id INT,
  target_agent_id INT,
  message TEXT
);

-- Columns the database computes for itself. `subtotal` derives from two ordinary columns,
-- `status_code` from a JSON payload — the two shapes a consumer actually meets. Neither may
-- be named in an INSERT or an UPDATE: the engine rejects the whole statement, so the
-- generated schema must not offer them as writable fields. STORED and VIRTUAL are both
-- covered: MySQL reports them as different values of information_schema EXTRA.
CREATE TABLE computed_line (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payload JSON NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  price INT NOT NULL DEFAULT 0,
  subtotal INT GENERATED ALWAYS AS (qty * price) STORED,
  status_code VARCHAR(50) GENERATED ALWAYS AS (payload->>'$.status') VIRTUAL
);

-- MySQL has no IDENTITY: AUTO_INCREMENT is the equivalent, and the table exists on both
-- dialects so the integration suite can assert the same generated shape either way.
CREATE TABLE identity_row (
  id INT AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(255) NOT NULL
);

-- A view: an aggregation over two base tables. It has an `id` column that is unique here
-- (one row per customer), which is the case the table generator may infer a key from.
CREATE VIEW customer_summary AS
  SELECT c.id AS id, c.name AS name, c.email AS email,
         COUNT(o.id) AS order_count,
         CAST(COALESCE(SUM(o.total), 0) AS SIGNED) AS total_spent
  FROM customer c
  LEFT JOIN customer_order o ON o.customer_id = c.id
  GROUP BY c.id, c.name, c.email;

-- A view with no plausible primary key at all: the generator must refuse to invent one
-- rather than take `order_count` for a key.
CREATE VIEW order_status_count AS
  SELECT status, COUNT(*) AS order_count FROM customer_order GROUP BY status;

-- MySQL has no materialized views; the PostgreSQL fixture covers that path.

-- A view simple enough that MySQL makes it updatable on its own. Writing through a view is a
-- legitimate use — a projection or permission layer — so the plugin must not close it off
-- wholesale; only the generated template starts read-only.
CREATE VIEW customer_active AS
  SELECT id, name, email, is_active FROM customer WHERE is_active = 1;
