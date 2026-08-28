CREATE TABLE customer (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  tax_number VARCHAR(50),
  fiscal_code VARCHAR(50),
  email VARCHAR(255),
  phone_number VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT true,
  organization_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ,
  updated_by INTEGER
);

CREATE TABLE product (
  id SERIAL PRIMARY KEY,
  uuid UUID NOT NULL DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price NUMERIC(10, 2) NOT NULL,
  quantity INT4 NOT NULL DEFAULT 0,
  weight FLOAT8,
  tags VARCHAR[] DEFAULT '{}',
  metadata JSONB,
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE customer_order (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  delivery_time TIME,
  total NUMERIC(12, 2) NOT NULL,
  notes TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  items JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);

-- Composite primary key (product_id, lang) — translations-style table
CREATE TABLE product_translation (
  product_id INTEGER NOT NULL REFERENCES product(id),
  lang VARCHAR(8) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  PRIMARY KEY (product_id, lang)
);

-- Unique parent of customer (via customer.organization_id, no DB-level FK on purpose).
-- Enables combining a unique joinLeft and a multiple joinGroup on the same main table
-- (see test/integration/agg-orderby-joinleft.test.js).
CREATE TABLE organization (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  city VARCHAR(255)
);

-- betterauth-style table: camelCase column names (quoted identifiers preserve case in PG)
CREATE TABLE "userAccount" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "providerId" VARCHAR(50) NOT NULL,
  "accountId" VARCHAR(255) NOT NULL,
  "accessToken" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT now(),
  "updatedAt" TIMESTAMPTZ
);

-- A row owned by two parties, visible to either: the shape `tenantScope: { anyOf: [...] }`
-- exists for. Both owner columns are nullable on purpose — a NULL party must not match, and
-- must not stop the other party from matching.
CREATE TABLE shift_swap_request (
  id SERIAL PRIMARY KEY,
  shift_id INTEGER,
  requester_agent_id INTEGER,
  target_agent_id INTEGER,
  message TEXT
);

-- Columns the database computes for itself. `subtotal` derives from two ordinary columns,
-- `status_code` from a JSON payload — the two shapes a consumer actually meets. Neither may
-- be named in an INSERT or an UPDATE: the engine rejects the whole statement, so the
-- generated schema must not offer them as writable fields.
CREATE TABLE computed_line (
  id SERIAL PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}',
  qty INTEGER NOT NULL DEFAULT 1,
  price INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER GENERATED ALWAYS AS (qty * price) STORED,
  status_code TEXT GENERATED ALWAYS AS (payload->>'status') STORED
);

-- `GENERATED ALWAYS AS IDENTITY` has no column_default to reveal that the DB fills it in,
-- which is what used to make the generated schema declare the PK mandatory.
CREATE TABLE identity_row (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label VARCHAR(255) NOT NULL
);

-- A view: an aggregation over two base tables. It has an `id` column that is unique here
-- (one row per customer), which is the case the table generator may infer a key from.
CREATE VIEW customer_summary AS
  SELECT c.id, c.name, c.email,
         count(o.id)::int AS order_count,
         coalesce(sum(o.total), 0)::int AS total_spent
  FROM customer c
  LEFT JOIN customer_order o ON o.customer_id = c.id
  GROUP BY c.id, c.name, c.email;

-- A view with no plausible primary key at all: the generator must refuse to invent one
-- rather than take `order_count` for a key.
CREATE VIEW order_status_count AS
  SELECT status, count(*)::int AS order_count FROM customer_order GROUP BY status;

-- A materialized view. PostgreSQL does not describe these in information_schema at all, so
-- they are introspected from pg_catalog; without that they were silently absent.
CREATE MATERIALIZED VIEW product_stock AS
  SELECT id, name, quantity FROM product;

-- A view simple enough that PostgreSQL makes it updatable on its own. Writing through a view
-- is a legitimate use — a projection or permission layer — so the plugin must not close it off
-- wholesale; only the generated template starts read-only.
CREATE VIEW customer_active AS
  SELECT id, name, email, is_active FROM customer WHERE is_active;
