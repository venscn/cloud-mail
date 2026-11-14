-- Independent display-only upgrade; never replay 0001/0002 for this feature.
-- Users must configure both new hosts. No legacy backfill or storage migration.
-- Raw SQL is one-shot. Use the per-column PRAGMA-guarded CLI for resumable upgrades.
ALTER TABLE setting ADD COLUMN gateway_imap_hostname TEXT NOT NULL DEFAULT '';
ALTER TABLE setting ADD COLUMN gateway_smtp_hostname TEXT NOT NULL DEFAULT '';
