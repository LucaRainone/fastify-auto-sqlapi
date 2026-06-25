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
