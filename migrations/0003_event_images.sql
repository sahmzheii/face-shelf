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
