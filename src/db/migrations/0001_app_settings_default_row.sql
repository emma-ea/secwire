-- SPEC §5: app_settings is a single-row table; the initial install inserts the
-- default row (scheduler on, 15-min interval, enrichment refresh on).
INSERT INTO "app_settings" ("id") VALUES (true) ON CONFLICT ("id") DO NOTHING;
