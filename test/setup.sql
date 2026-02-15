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
