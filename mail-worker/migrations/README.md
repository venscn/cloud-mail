# Gateway v1: explicit D1 migration and raw-storage prerequisites

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

## R2 privacy and compatibility

- The protocol gateway requires an R2 binding named `r2` with read/write access. Immutable MIME is stored under the reserved `private-gateway/` prefix, with byte length, SHA-256 and an authenticated per-account mapping in D1.
- **That bucket must not expose these objects through an R2 public-development URL, public custom domain, permissive second Worker, CDN or object listing.** This release rejects reserved-prefix keys on Cloud Mail's public object/attachment routes, including multiply encoded/backslash/case variants. It cannot revoke a separate public R2 endpoint. Use a genuinely private binding; do not treat an unguessable key or the application's HTTP guard as bucket privacy.
- Ordinary webmail receive remains compatible without this binding, without the gateway migration, and when an optional raw write fails. The existing legacy attachment storage still supports configured S3/R2/KV. Raw capture is best-effort for ordinary receive; failures are warned but do not strand the legacy message in its saving state. Do not switch a legacy S3/KV attachment store merely to enable this feature without auditing attachment availability.
- If private R2 was unavailable for an earlier message, the original bytes were not retained. A later gateway read may deterministically reconstruct and freeze MIME from legacy content/attachments. It is labeled `raw_source: reconstructed` and `X-CMG-Reconstructed: yes`, **never** `received`. A fresh receive captured successfully is labeled `received` and preserves the exact inbound bytes.
- Received/raw download limit is 25 MiB; APPEND and submission limit is 10 MiB. APPEND stores a mailbox instance only and never invokes a delivery provider.

## Historical projection and lazy freezing

The migration creates durable per-account state, six special-use folders and live legacy-change triggers. Historical UID projection is a separate per-account SQL-only batch (500 rows). It does not read attachments, reconstruct MIME, or require R2, so one broken/oversized old message cannot keep an entire INBOX inaccessible. A large account reports bounded `SYNC_IN_PROGRESS` until subsequent authenticated calls have projected remaining rows. Existing status-6 receive/saving, status-7 failure and status-9 gateway-pending rows are excluded until their legitimate promotion.

Old message MIME is frozen only when requested (for example raw read or COPY); a bounded D1 lease serializes reconstruction. Missing or oversized historical content is explicit per-message metadata (`raw_available: false`, `raw_error`, `size_is_estimate: true`, unknown size `0`), not fabricated original size and not account-wide readiness failure. Retryable failures may be cleared through the authenticated backfill maintenance route. Do not delete/change immutable raw objects manually.

Snapshot cursors are signed, account/user bound and expire after seven days. Snapshot changes return 409; expired or pruned change cursors return 410 and require a fresh snapshot. Do not erase tombstones/change state to recover a single mail item or to save storage without the supported bounded pruning path.

## Offline evidence and limits

The isolated regression configurations do not load production Wrangler files and never deploy, provision a bucket, send real mail or call remote D1:

```sh
node scripts/gateway-migration.mjs --check
npx vitest run --config vitest.gateway.config.js
npx vitest run --config vitest.sender.config.js
```

The core suite runs real local SQLite transactions/triggers; the sender/staging suite also validates workerd/D1-specific behavior with synthetic bindings. These checks are not proof of live permissions, R2 public-domain privacy, production quotas, an actual VPS/iOS login, or end-to-end external delivery. Those remain explicit operator acceptance tasks. **Do not run the package's default `test` script as an offline check: it includes deployment behavior.**
