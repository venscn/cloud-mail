# Gateway v1: explicit D1 metadata migration (relay only)

These assets belong to the **matching Cloud Mail Worker source release**, not the separately released Go gateway binary. They do not provision or deploy anything on their own.

## What runs, and when

- **Normal Worker startup does not migrate D1.** Neither a capabilities request nor an ordinary received message runs schema creation. Until `gateway_meta.schema_version = 1` is present, authenticated gateway operations fail closed with HTTP 503 / `GATEWAY_NOT_INITIALIZED`.
- The existing explicit initializer, `GET /api/init/:secret`, first checks the supplied path secret against `jwt_secret`, then runs the existing legacy migrations through v3.7, calls the canonical gateway migration in **one transactional D1 batch**, refreshes settings, and returns `success`. See [initializer](../src/init/init.js). This is an operator action, not a deploy/startup hook. Existing legacy migrations have their own historical error handling and are not one transaction with the gateway batch.
- The initializer places a powerful secret in the URL path. Do not paste a real URL into chat, tickets, browser history, screenshots, logs or shell history. For an already-initialized v3.7 installation, prefer the authenticated Cloudflare D1 operator flow below; it needs no application secret in a URL.
- [0001_gateway_v1.sql](./0001_gateway_v1.sql) is a complete, additive, repeatable mirror of [the canonical statement array](../src/gateway/schema.js). It **does not create or upgrade the legacy Cloud Mail tables**. Do not apply it to an empty or old-schema database. It is not an instruction to run all Wrangler migrations indiscriminately.

## Controlled operator flow (not executed by these tests)

1. Obtain the matching full Cloud Mail source, confirm the actual target account/Worker/D1 binding in an operator-controlled configuration, and take a private D1 backup. Never substitute a database name guessed from an example. Keep database exports and configuration out of the public repository.
2. Rehearse against a separate local/staging copy whose legacy schema is already at v3.7, with synthetic or approved sanitized mail only. Verify application-password creation, ordinary receive, protocol login and rollback plans before authorizing a production change.
3. From `mail-worker`, verify the checked-in SQL mirror **offline**:

   ```sh
   node scripts/gateway-migration.mjs --check
   ```

   Only a maintainer intentionally changing the canonical migration should regenerate it with `--write` and review the resulting SQL diff. Never hand-edit the mirror.
4. If the legacy database is already at v3.7, an authorized operator may use the pinned project Wrangler dependency to execute only this reviewed SQL. The following are templates, **not commands run by development/tests**; replace all placeholders locally:

   ```sh
   npx wrangler d1 export '<D1_DATABASE_NAME_OR_ID>' --remote --output '<PRIVATE_BACKUP_PATH>' --config '<OPERATOR_WRANGLER_CONFIG>'
   npx wrangler d1 execute '<D1_DATABASE_NAME_OR_ID>' --remote --file migrations/0001_gateway_v1.sql --config '<OPERATOR_WRANGLER_CONFIG>'
   npx wrangler d1 execute '<D1_DATABASE_NAME_OR_ID>' --remote --command "SELECT value FROM gateway_meta WHERE key='schema_version';" --config '<OPERATOR_WRANGLER_CONFIG>'
   ```

   Use `--local` instead of `--remote` only for the deliberate isolated rehearsal. Check CLI output and the schema-version query; a successful deploy alone is not migration evidence. The direct SQL flow is additive and safe to repeat after a failed attempt; Wrangler may split the file, so do not assume that path has the same one-batch atomicity as the Worker initializer. The schema marker is last. Keep the old Worker/bindings and backup available until staging and live smoke checks are approved. Do not drop legacy tables or reset UID/credential tables during rollback.
5. For a new or pre-v3.7 installation, first run the existing full initialization/upgrade process using an approved secure operator method. Applying this gateway-only SQL is not a substitute for that process. If the URL initializer is used, protect and redact all access logs that could capture its path; do not document or share the actual secret.

The migration uses `CREATE ... IF NOT EXISTS`, `INSERT OR IGNORE`, uniqueness constraints, and stable counters. Replaying this **same** v1 migration does not reset UIDs, UIDVALIDITY, revisions, raw mappings or credentials. Future schema changes need a new versioned migration; changing a `CREATE TRIGGER IF NOT EXISTS` body does not upgrade an already-created trigger.

## 0002: historical single-host display settings (superseded)

The following describes the historical release only. Current runtime ignores `gateway_hostname`, rejects `gatewayHostname` writes and does not expose it. Apply the independent 0003 migration below and configure the two new hosts; do not replay 0002 for this update.

[0002_gateway_settings.sql](./0002_gateway_settings.sql) adds only `setting.gateway_enabled` (integer 0/1, default 0) and `setting.gateway_hostname` (text, default empty). **Do not change or replay 0001 for this feature.** It does not change protocol authentication, existing application passwords, message storage or delivery. Turning the display switch off is not a network security boundary and deliberately does not disconnect an already deployed gateway.

API fields are `gatewayEnabled` (numeric 0/1 only) and `gatewayHostname` (string). The existing permission-protected `/setting/set` and `/setting/query` routes remain in use; `/setting/websiteConfig` explicitly allowlists these two public values and no gateway secrets. The hostname is trimmed and lowercased; only ASCII DNS names with at least two labels, each 1–63 characters and at most 253 total, are accepted. Labels may contain letters, digits and internal hyphens; the last label must contain a letter. URLs, IP addresses, paths, ports, whitespace/control characters, Unicode and injection syntax are rejected. Empty hostname is allowed only while disabled. This validates syntax, not DNS/TLS/service availability.

Before the matching Worker is deployed, an authorized operator must back up the actual target database and rehearse the additive upgrade against an isolated synthetic copy. Prefer the **per-column PRAGMA-guarded tool**, which resumes safely after a partial application and never resets existing setting values:

```sh
# Plan only: explicit config, explicit database and explicit local/remote are mandatory.
node scripts/gateway-settings-migration.mjs --config '<OPERATOR_CONFIG>' --database '<D1_NAME_OR_ID>' --local
# After reviewing the plan and target, apply to the isolated rehearsal.
node scripts/gateway-settings-migration.mjs --config '<OPERATOR_CONFIG>' --database '<D1_NAME_OR_ID>' --local --apply
# Only a separately approved controlled release substitutes --remote for --local.
```

The tool executes only `PRAGMA table_info(setting)` and the missing `ALTER TABLE` statements, then verifies both column names. It does not load configuration itself, select mail/credentials/settings values, update KV, deploy a Worker or implicitly choose production. Wrangler reads the explicitly supplied operator configuration. Run one migration operator at a time. Missing legacy tables or actual D1 failures fail loudly, not as duplicate-column success. [The SQL file](./0002_gateway_settings.sql) is an alternative for a migration runner tracking it exactly once; raw SQLite `ADD COLUMN` statements are **not** blindly replayable. Do not run all directory migrations merely to apply this change.

The historical release used [the 0002 helper](../src/init/gateway-settings-migration.js). Current initialization no longer invokes that helper or creates a single-host column. Keep the historical SQL/helper unchanged for already-deployed migration history; they are not the current update path. Ordinary startup/requests do not migrate. Do not drop columns, reset settings, revoke passwords or touch gateway tables.

Offline checks (no Wrangler/production config, no account/mail/password reads, no remote service):

```sh
node node_modules/vitest/vitest.mjs run --config vitest.settings.config.js
```

## 0003: separate IMAP and SMTP display hostnames

[0003_gateway_split_hosts.sql](./0003_gateway_split_hosts.sql) adds only two TEXT NOT NULL columns, `gateway_imap_hostname` and `gateway_smtp_hostname`, default empty string. No data backfill, mail-table migration or storage change is needed. **Do not edit/replay 0001 or 0002 to apply 0003.** Existing installations need the `gateway_enabled` column from the historical release. Fresh initialization includes only the new host columns; the explicit initializer uses the separate 0003 guarded helper, never ordinary startup.

Current runtime API fields are only `gatewayEnabled` (numeric 0/1), `gatewayImapHostname` and `gatewaySmtpHostname` (strings). The hosts update independently and never fall back to `gatewayHostname`. Missing/null/empty/invalid values fail closed. Enabling requires both hosts to be valid nonempty ASCII FQDNs under the existing syntax rules. Supplied non-string/invalid hosts are rejected even while disabled; empty strings may be saved only while disabled. Legacy `gatewayHostname` parameters are rejected before any write, and old cache values are stripped from reads. Users must configure both new hosts themselves. Historical DB columns/data remain untouched but are not mapped or read by the runtime; no dangerous DROP is required. The setting is display-only: authentication, application passwords and delivery are unchanged.

D1 and refresh/KV preserve stored state for validation. Admin `/setting/query` (service `get`) and public `websiteConfig` resolve the same safe effective values: normalized strings, invalid/empty as empty, and enabled 0 unless both are valid. Output resolution/masking never mutates source state. When saving changes, new clients send the current displayed `gatewayEnabled` explicitly plus only changed host fields, not all settings; this prevents an old stored-on flag from unexpectedly enabling newly entered hosts. No old single-host field is returned by admin/public reads.

An authorized operator, after backup and isolated rehearsal, uses the independent guarded tool:

```sh
# Plan only; explicit target/config and local/remote are mandatory.
node scripts/gateway-split-hosts-migration.mjs --config '<OPERATOR_CONFIG>' --database '<D1_NAME_OR_ID>' --local
# Apply only 0003 missing columns; safe to repeat or resume a partial application.
node scripts/gateway-split-hosts-migration.mjs --config '<OPERATOR_CONFIG>' --database '<D1_NAME_OR_ID>' --local --apply
```

This tool checks `PRAGMA table_info(setting)`, requires `gateway_enabled`, adds only missing 0003 columns and verifies them. It does not select settings/mail/credentials, replay prior migrations, refresh KV, deploy, or discover configuration. Only a separately authorized release substitutes `--remote`. Run one operator at a time. The SQL alternative is one-shot, not blindly replayable. Deploy matching Worker only after columns exist, then refresh/save through the authorized admin flow. Old KV lacking split fields remains display-disabled until both new hosts are configured. Rollback retains additive columns and historical data. Offline settings tests exercise real synthetic SQLite and mock the CLI (no Wrangler/config/network).

## Existing storage only; no new R2 prerequisite

- The gateway does not create or store raw MIME objects. Do not enable R2 billing, create a bucket, or switch attachment backends for this feature. Existing email and attachment data remain in Cloud Mail's configured S3/KV/R2 abstraction.
- Raw reads deterministically reconstruct MIME from existing email/attachment data. D1 stores only descriptor size/hash metadata (`legacy:<emailId>` is an internal descriptor identifier, not a raw object address). Every read checks the descriptor; changed content returns HTTP 409 rather than overwriting the hash.
- The v1 serializer and reconstructed headers are a byte-stability contract. Future changes must not silently alter bytes for an existing UID or replace its descriptor to hide a mismatch; use an explicitly reviewed compatibility/version transition.
- No inbound raw capture or submission raw-object write is performed. SMTP raw bytes exist only within the request lifecycle; the existing send pipeline, Sent persistence and attachment storage remain in use. D1 retains idempotency/envelope hashes and results, not a replayable raw message.
- New APPEND (including drafts) and COPY return HTTP 501 / IMAP `NO [CANNOT]`. MOVE changes existing message metadata mappings. The sole existing-Sent APPEND ACK requires exact equality of both `payload_hash` and `envelope_hash`, never approximate matching; it neither stores a new copy nor sends mail.
- Raw download limit is 25 MiB; submission/APPEND input limit is 10 MiB. Reconstruction does not promise recovery of original inbound MIME or full submitted raw bytes.

## Historical projection and lazy descriptors

The migration creates durable per-account state, six special-use folders and live legacy-change triggers. Historical UID projection is a separate per-account SQL-only batch (500 rows). It does not read attachments, reconstruct MIME, or require R2, so one broken/oversized old message cannot keep an entire INBOX inaccessible. A large account reports bounded `SYNC_IN_PROGRESS` until subsequent authenticated calls have projected remaining rows. Existing status-6 receive/saving, status-7 failure and status-9 gateway-pending rows are excluded until their legitimate promotion.

MIME is reconstructed only when requested for a supported read; a bounded D1 lease serializes descriptor establishment, not object storage. Missing or oversized historical content is explicit per-message metadata (`raw_available: false`, `raw_error`, `size_is_estimate: true`, unknown size `0`), not fabricated original size and not account-wide readiness failure. Retryable failures may be cleared through the authenticated backfill maintenance route. Do not change descriptor hashes to conceal a content mismatch.

Snapshot cursors are signed, account/user bound and expire after seven days. Snapshot changes return 409; expired or pruned change cursors return 410 and require a fresh snapshot. Do not erase tombstones/change state to recover a single mail item or to save storage without the supported bounded pruning path.

## Offline evidence and limits

The isolated regression configurations do not load production Wrangler files and never deploy, provision a bucket, send real mail or call remote D1:

```sh
node scripts/gateway-migration.mjs --check
npx vitest run --config vitest.gateway.config.js
npx vitest run --config vitest.sender.config.js
```

The core suite runs real local SQLite transactions/triggers; the sender/staging suite also validates workerd/D1-specific behavior with synthetic bindings. These checks are not proof of live permissions, existing attachment availability, production quotas, an actual VPS/iOS login, or end-to-end external delivery. Those remain explicit operator acceptance tasks. **Do not run the package's default `test` script as an offline check: it includes deployment behavior.**
