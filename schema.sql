PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS page_connections (
  page_id TEXT PRIMARY KEY,
  page_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  access_token_cipher TEXT NOT NULL,
  graph_version TEXT NOT NULL DEFAULT 'v26.0',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES page_connections(page_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_settings (
  page_id TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  theme_color TEXT NOT NULL DEFAULT '#256f4a',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES page_connections(page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_page_selections (
  id TEXT PRIMARY KEY,
  pages_cipher TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  permalink_url TEXT NOT NULL DEFAULT '',
  created_time TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES page_connections(page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_page_id_created_time
  ON posts(page_id, created_time DESC);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  facebook_photo_id TEXT,
  image_url TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  target_url TEXT,
  caption TEXT NOT NULL DEFAULT '',
  original_caption TEXT NOT NULL DEFAULT '',
  sold INTEGER NOT NULL DEFAULT 0,
  is_artwork INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES page_connections(page_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_products_page_post
  ON products(page_id, post_id, sort_index);

CREATE INDEX IF NOT EXISTS idx_products_page_photo
  ON products(page_id, facebook_photo_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  tag_color TEXT NOT NULL DEFAULT '#ffffff',
  tag_background_color TEXT NOT NULL DEFAULT '#256f4a',
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

CREATE TABLE IF NOT EXISTS event_images (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting')),
  delete_after INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (id, status)
);

CREATE INDEX IF NOT EXISTS idx_event_images_cleanup ON event_images(status, delete_after);
CREATE INDEX IF NOT EXISTS idx_event_images_page ON event_images(page_id);

CREATE TABLE IF NOT EXISTS event_image_refs (
  event_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  image_status TEXT NOT NULL DEFAULT 'active' CHECK (image_status = 'active'),
  PRIMARY KEY (event_id, image_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id, image_status) REFERENCES event_images(id, status)
);

CREATE INDEX IF NOT EXISTS idx_event_image_refs_image ON event_image_refs(image_id);
