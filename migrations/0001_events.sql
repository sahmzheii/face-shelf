CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES page_connections(page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_page ON events(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_products (
  event_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  PRIMARY KEY (event_id, product_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_products_product ON event_products(product_id);
