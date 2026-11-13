# Sender identity regression tests

From `mail-worker`, run explicitly:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.sender.config.js
```

**Do not use `npm test` / `pnpm test`: the repository's existing test script deploys a Worker.**

The dedicated configuration runs an isolated Cloudflare Worker runtime, without loading any Wrangler configuration, production bindings, environment secrets, or settings. The runtime compatibility date matches the installed test runtime.

The suite exercises the real service methods and the real `worker-mailer` `Email` MIME generator. Only the SMTP connection boundary (`WorkerMailer.connect`), the Resend API client, and the Cloudflare email binding are replaced with test doubles. No test sends mail. `postal-mime` parses serialized MIME to verify recipients will receive the intended name/address headers, including quote and Unicode handling.

Coverage includes:

- SMTP envelope configuration precedence and clearing a saved override.
- SendPulse authorized envelope versus actual visible account, dynamic same-domain addresses, lowercase names, threading headers, display-name escaping, CRLF injection prevention, validation before connecting, immutability, and connection cleanup after failure.
- QQ login-address From, actual account Reply-To, plain/HTML identity notices at the beginning of the body, HTML escaping, full-document notice placement, unsafe mailbox rejection, name injection prevention, single-format bodies, and input immutability.
- Dynamic actual-account From values for Cloudflare and Resend.
- Default Resend → SendPulse → QQ → CF priority, administrator overrides, and skipping unavailable channels.

For the settings dialog regression tests, from `mail-vue` run:

```powershell
node --test test/send-chain.test.mjs
```

These use Vue's SFC parser to execute the actual `openSendChain` / `moveChain` handlers with mocked HTTP and notifications. They cover saving and reopening, preserving the committed order for later settings updates, rollback on failure, blocking overlapping saves, readiness, and move boundaries. They do not render a browser UI.

These are serialization/contract tests, not provider-delivery tests. Provider acceptance, domain authorization, final recipient display and delivery still need separately authorized live checks.
