-- UI display configuration only; does not gate protocol authentication or delivery.
-- 0001 is already deployed: do not edit or replay it for this change.
-- SQLite lacks ADD COLUMN IF NOT EXISTS. Apply once through migration tracking,
-- or use scripts/gateway-settings-migration.mjs for per-column PRAGMA guards.
ALTER TABLE setting ADD COLUMN gateway_enabled INTEGER NOT NULL DEFAULT 0 CHECK (gateway_enabled IN (0, 1));
ALTER TABLE setting ADD COLUMN gateway_hostname TEXT NOT NULL DEFAULT '';
