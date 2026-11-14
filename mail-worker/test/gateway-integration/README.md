# Real cross-language gateway integration

These tests run real Go TLS IMAP/SMTP listeners, the real Go HTTPS backend client,
and Cloud Mail's actual Hono gateway API, credential/session authentication,
submission state machine, migrations, mailbox store and raw-message helpers.
They do **not** serve a fake gateway API or inject an authenticated principal.

## Run safely

Prerequisites: installed Worker dependencies, Node with `node:sqlite`, Go 1.26+
with the pinned gateway dependencies available, and the sibling checkout layout
`cloud-mail/` next to `cloud-mail-gateway/`.

From the Worker directory, use the independent Node configuration:

```powershell
$env:GOTOOLCHAIN = 'local'
# Only if the intended Go executable is not already on PATH:
# $env:CMG_INTEGRATION_GO = 'C:\path\to\go.exe'
.\node_modules\.bin\vitest.cmd run --config vitest.gateway-integration.config.js
```

Do not substitute `npm test` or a deployment/Workers-pool configuration. This
suite needs no Wrangler configuration, Cloudflare binding, live credentials,
public listener or external email provider.

The runner creates a new in-memory SQLite/existing-attachment KV fixture and real synthetic
application passwords for each case. The Node adapter binds only `127.0.0.1`.
A Go `httptest` TLS reverse proxy forwards requests unchanged to the actual Hono
`fetch` handler; the backend client trusts only that test certificate. Protocol
clients also verify TLS. The private control endpoints only synchronize tests
and revoke a real credential; they do not implement gateway operations.

Running `go test -count=1 -v ./test/integration` in the gateway checkout without
the private fixture environment **explicitly skips** these cases. That command
alone is a compile check, not cross-language execution. The Vitest command above
runs every Go case against its actual live synthetic fixture.

## Assertions

Six Vitest cases invoke six real Go cases individually:

| Go case | Main checks |
| --- | --- |
| `TestCloudTLSAndAuth` | HTTPS/TLS trust rejection, real application-password exchange, mailbox/account identity and scopes |
| `TestCloudIMAPLifecycle` | seeded legacy mail, deterministic reconstructed MIME semantics/size/ranges, PEEK/Seen, stable UID/UIDVALIDITY/flags after gateway server/backend recreation, COPY/new APPEND refusal, MOVEUID; no outbound dispatch |
| `TestCloudAuthorization` | EXAMINE cannot mutate, read-only scope, account isolation, credential revocation on an already authenticated session |
| `TestCloudSMTPSubmission` | AUTH forbidden before STARTTLS, verified STARTTLS and implicit TLS, sender/envelope binding, header-only recipients cannot expand delivery, Bcc-only envelope, durable dispatch state, canonical-envelope retry deduplication, changed bytes with the same Message-ID submit separately, reconstructed Sent text/binary attachments, exact payload+envelope Sent APPEND ACK once; repeated/changed APPEND refusal |
| `TestCloudSMTPPendingIsolation` | Actual legacy `completeReceiveAll` runs after actual Sent-ledger staging and before the guarded commit; actual `GATEWAY_PENDING` remains unchanged, TLS IMAP SELECT/FETCH cannot expose it, SMTP cannot acknowledge yet; after release exactly one committed copy is readable |
| `TestCloudSMTPUnknownOutcome` | Exception after durable dispatch becomes `unknown/reconcile_required`; reconnect/retry returns temporary failure without a second dispatch or fabricated Sent copy |

The pending-state test uses explicit promise/control barriers, not sleeps. MIME
contains CRLF, UTF-8, dot-stuffing-sensitive lines and a binary attachment. Deterministic reconstruction (not original SMTP wire bytes) is required. Byte
mismatch diagnostics show only lengths and hashes, not full MIME. Credentials
are passed only through the child environment and are not logged.

The same configuration also runs eleven HTTP boundary cases against the real
Worker entry point (not just the gateway Hono sub-app). They verify exact v1
namespace dispatch, HTTPS, no web-KV dependency for public capabilities, JWT/app
password/session separation, real JWT plus live KV web sessions, one-time secret
management, account ownership, strict request fields and sanitized HTTP errors.
These cases use only synthetic signing material and local SQLite/existing-attachment KV; no
production configuration is loaded.

## Deliberate boundaries and limitations

- Only `email-service.send` is replaced at the provider/save boundary. The
  synthetic sender calls the real execution hooks, persists a staged legacy
  email using the actual pending enum, saves attachments through actual `attService.saveSendAtt` into existing KV, calls actual `recordSentCopy`, and invokes
  the real guarded `commitEmailStatus`. The real legacy cron method is retained
  by a partial module mock and actually executes SQL.
- The Cloudflare-only `worker-mailer` import has inert entry points which throw
  if invoked. It is an import guard, not a simulated successful SMTP provider.
- No real provider selection, provider SDK serialization, delivery, billing,
  quota integration or production send-channel acceptance is exercised.
- The storage harness is Node SQLite plus synthetic existing KV (no R2 binding), not deployed D1/R2.
- Persistence is verified across gateway backend/server object recreation with
  unchanged Worker authority, not an OS crash or a production failover.
- No deployed VPS, iOS client, real mailbox or production acceptance is claimed.
- This suite does not collect percentage coverage.

Relay fixtures seed historical email rows and attachment bytes without APPEND. Gateway raw rows contain only legacy references, sizes and SHA-256 metadata; no original MIME or private raw object is stored. KV writes reject every non-attachment key except synthetic settings.
