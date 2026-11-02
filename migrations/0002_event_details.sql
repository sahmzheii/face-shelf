ALTER TABLE events ADD COLUMN tag TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN tag_color TEXT NOT NULL DEFAULT '#ffffff';
ALTER TABLE events ADD COLUMN tag_background_color TEXT NOT NULL DEFAULT '#256f4a';
UPDATE events SET tag = name WHERE tag = '';
