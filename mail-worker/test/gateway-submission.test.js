import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { address, parseEnvelope, prepareMime, readRaw, sha256, withoutBcc, MAX_MESSAGE_BYTES } from '../src/gateway-submission/validation';
import { SubmissionRepository } from '../src/gateway-submission/repository';
import { createSubmissionService } from '../src/service/gateway-submission-service';
import { GatewayError } from '../src/gateway/errors';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const principal = { accountId: '7', userId: '9', mailboxAddress: 'sender@example.test', sessionId: 'synthetic-session' };
const envelope = { mail_from: principal.mailboxAddress, rcpt_to: ['to@example.test', 'cc@example.test', 'hidden@example.test'] };
const encodeEnvelope = value => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mime = (headers = '', body = 'Synthetic plain body\r\n') => `From: Client Name <sender@example.test>\r\nTo: to@example.test, header-only@example.test\r\nCc: cc@example.test\r\nBcc: hidden@example.test\r\nMessage-ID: <synthetic-1@example.test>\r\nSubject: Synthetic submission\r\nDate: Sat, 14 Nov 2026 00:00:00 +0000\r\n${headers}\r\n${body}`;
const prepare = (raw = mime(), selected = envelope) => prepareMime(encoder.encode(raw), selected, principal);
const context = (key = 'synthetic-key-1', raw = mime(), selected = envelope) => ({
	env: { db: env.SUBMISSION_TEST_DB },
	req: { raw: new Request('https://worker.example.test/api/gateway/v1/submissions', {
		method: 'POST', headers: { 'content-type': 'message/rfc822', 'idempotency-key': key, 'x-cmg-envelope': encodeEnvelope(selected) }, body: raw
	}) }
});

beforeEach(async () => {
	await env.SUBMISSION_TEST_DB.exec(`CREATE TABLE IF NOT EXISTS gateway_submissions (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, user_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, envelope_json TEXT NOT NULL, raw_key TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '', state TEXT NOT NULL CHECK(state IN ('sending','sent','failed','unknown')), phase TEXT NOT NULL DEFAULT 'preparing', result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(account_id,idempotency_key)); CREATE TABLE IF NOT EXISTS account(account_id INTEGER PRIMARY KEY, user_id INTEGER, is_del INTEGER DEFAULT 0); DELETE FROM gateway_submissions; DELETE FROM account; INSERT INTO account(account_id,user_id,is_del) VALUES(7,9,0);`);
});

function harness(overrides = {}) {
	const storage = { putObj: vi.fn().mockResolvedValue(undefined) };
	const authorize = vi.fn().mockResolvedValue(principal);
	const send = vi.fn(async (_c, _params, _user, execution) => {
		await execution.onAttempt(envelope.rcpt_to, 'synthetic-provider');
		await execution.onAccepted(envelope.rcpt_to, 'synthetic-provider');
		await execution.onSentSaved(42);
	});
	const service = createSubmissionService({ storage, authorize, send, ...overrides });
	return { service, storage, authorize, send };
}

describe('gateway MIME and SMTP envelope validation', () => {
	it('normalizes and deduplicates only the bounded authenticated ASCII envelope', () => {
		expect(parseEnvelope(encodeEnvelope({ mail_from: 'Sender@Example.Test', rcpt_to: ['To@example.test', 'to@example.test'] }), principal)).toEqual({ mail_from: principal.mailboxAddress, rcpt_to: ['to@example.test'] });
		expect(() => parseEnvelope(encodeEnvelope({ ...envelope, mail_from: 'other@example.test' }), principal)).toThrowError(/authenticated mailbox/);
		expect(() => parseEnvelope(encodeEnvelope({ ...envelope, rcpt_to: Array(51).fill('to@example.test') }), principal)).toThrowError(/50 recipients/);
	});
	it.each(['a..b@example.test', '.a@example.test', 'a@-example.test', 'a@example-.test', 'a@example..test', 'a@example.test\r\nRCPT TO:x', 'Display <a@example.test>', '测试@example.test'])('rejects unsupported envelope %s', invalid => {
		expect(() => address(invalid)).toThrow();
	});
	it('keeps visible headers without adding them to delivery targets; envelope-only recipient stays Bcc', async () => {
		const result = await prepare();
		expect(result.params.receiveEmail).toEqual(['to@example.test']);
		expect(result.params.ccEmail).toEqual(['cc@example.test']);
		expect(result.params.bccEmail).toEqual(['hidden@example.test']);
		expect(result.gatewayHeaders.To).toBe('to@example.test, header-only@example.test');
		expect(result.gatewayHeaders.Cc).toBe('cc@example.test');
		expect(result.gatewayHeaders.Bcc).toBeUndefined();
		expect(result.messageId).toBe('<synthetic-1@example.test>');
	});
	it('treats omitted Bcc header identically and does not invent visible To for Bcc-only delivery', async () => {
		const raw = mime().replace('To: to@example.test, header-only@example.test\r\n', '').replace('Cc: cc@example.test\r\n', '').replace('Bcc: hidden@example.test\r\n', '');
		const result = await prepare(raw, { ...envelope, rcpt_to: ['hidden@example.test'] });
		expect(result.params.receiveEmail).toEqual([]);
		expect(result.params.bccEmail).toEqual(['hidden@example.test']);
		expect(result.gatewayHeaders.To).toBe('');
	});
	it.each([
		['another From identity', mime().replace('sender@example.test', 'other@example.test'), 'SENDER_FORBIDDEN'],
		['multiple From identities', mime().replace('Client Name <sender@example.test>', 'sender@example.test, other@example.test'), 'SENDER_FORBIDDEN'],
		['empty Sender', mime('Sender:\r\n'), 'SENDER_FORBIDDEN'],
		['different Sender', mime('Sender: other@example.test\r\n'), 'SENDER_FORBIDDEN'],
		['duplicate From', mime('From: sender@example.test\r\n'), 'SENDER_FORBIDDEN'],
		['resent identity', mime('Resent-From: sender@example.test\r\n'), 'INVALID_MIME'],
		['duplicate Message-ID', mime('Message-ID: <second@example.test>\r\n'), 'INVALID_MIME'],
		['bare CR injection', mime('X-Test: okay\rInjected: bad\r\n'), 'INVALID_MIME'],
		['invalid header name', mime('Bad Header: value\r\n'), 'INVALID_MIME'],
		['overlong physical header', mime(`X-Test: ${'a'.repeat(999)}\r\n`), 'INVALID_MIME']
	])('rejects %s before any send', async (_name, raw, code) => {
		await expect(prepare(raw)).rejects.toMatchObject({ code });
	});
	it('returns a safe MIME validation error for invalid UTF-8 headers', async () => {
		const bytes = encoder.encode(mime('X-Test: x\r\n'));
		bytes[bytes.indexOf(120)] = 0xff;
		await expect(prepareMime(bytes, envelope, principal)).rejects.toMatchObject({ status: 400, code: 'INVALID_MIME' });
	});
	it('hashes exact bytes and canonicalizes recipient order only', async () => {
		const first = await prepare();
		const reordered = await prepare(mime(), { ...envelope, rcpt_to: [...envelope.rcpt_to].reverse() });
		expect(first.requestHash).toBe(reordered.requestHash);
		expect(first.payloadHash).toBe(await sha256(encoder.encode(mime())));
		expect((await prepare(mime('', 'Changed body\r\n'))).requestHash).not.toBe(first.requestHash);
	});
	it('preserves MIME attachment bytes and inline CID references through parsing', async () => {
		const raw = mime('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="synthetic-boundary"\r\n', [
			'--synthetic-boundary', 'Content-Type: text/html; charset=utf-8', '', '<p>Body<img src="cid:pixel@example.test"></p>',
			'--synthetic-boundary', 'Content-Type: image/png', 'Content-ID: <pixel@example.test>', 'Content-Disposition: inline; filename="pixel.png"', 'Content-Transfer-Encoding: base64', '', 'AAECA/8=',
			'--synthetic-boundary', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="synthetic.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0=', '--synthetic-boundary--', ''
		].join('\r\n'));
		const result = await prepare(raw);
		expect(result.html).toContain('cid:pixel@example.test');
		expect(result.imageDataList).toHaveLength(1);
		expect(result.imageDataList[0]).toMatchObject({ contentId: 'pixel@example.test', mimeType: 'image/png', size: 5 });
		expect([...result.imageDataList[0].buff]).toEqual([0, 1, 2, 3, 255]);
		expect(result.params.attachments).toEqual([{ filename: 'synthetic.pdf', type: 'application/pdf', content: 'JVBERi0=' }]);
	});
	it('removes folded Bcc/Resent-Bcc only, retaining every binary body byte', () => {
		const header = encoder.encode('From: sender@example.test\r\nTo: to@example.test\r\nBcc: hidden@example.test,\r\n hidden2@example.test\r\nResent-Bcc: hidden3@example.test\r\nX-Synthetic-Very-Long-Header-Name-Without-Colon-Truncation: retained\r\n\r\n');
		const body = new Uint8Array([0, 255, 13, 10, 66, 99, 99, 58, 32, 120]);
		const input = new Uint8Array([...header, ...body]);
		const output = withoutBcc(input);
		expect([...output.slice(-body.length)]).toEqual([...body]);
		expect(decoder.decode(output.slice(0, -body.length))).not.toMatch(/hidden/);
		expect(decoder.decode(output)).toContain('Without-Colon-Truncation: retained');
	});
	it('enforces MIME content type and both advertised and streamed bounds', async () => {
		await expect(readRaw(new Request('https://example.test', { method: 'POST', body: 'x' }))).rejects.toMatchObject({ status: 415 });
		await expect(readRaw(new Request('https://example.test', { method: 'POST', headers: { 'content-type': 'message/rfc822', 'content-length': String(MAX_MESSAGE_BYTES + 1) }, body: 'x' }))).rejects.toMatchObject({ status: 413 });
		await expect(readRaw(new Request('https://example.test', { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: new Uint8Array(MAX_MESSAGE_BYTES + 1) }))).rejects.toMatchObject({ status: 413 });
	});
});

describe('durable synchronous gateway submissions (synthetic D1)', () => {
	it('keeps MIME request-local and returns sent only after all recipients and Sent are saved', async () => {
		const h = harness();
		const result = await h.service.submit(context(), principal);
		expect(result).toMatchObject({ state: 'sent', acceptance: 'channel_accepted', retryable: false, requires_reconciliation: false });
		expect(result.recipients.every(item => item.state === 'accepted')).toBe(true);
		expect(h.storage.putObj).not.toHaveBeenCalled();
		expect(decoder.decode(h.send.mock.calls[0][3].rawBytes)).toBe(mime());
		const row = await new SubmissionRepository(context()).byId(principal, result.id);
		expect(JSON.parse(row.result_json).email_ids).toEqual([42]);
		expect(row.raw_key).toBe('');
		expect(JSON.stringify(row)).not.toContain('Synthetic plain body');
	});
	it('never dispatches a duplicate POST and conflicts on the same key with changed bytes', async () => {
		const h = harness();
		const first = await h.service.submit(context(), principal);
		expect((await h.service.submit(context(), principal)).id).toBe(first.id);
		expect(h.send).toHaveBeenCalledOnce();
		await expect(h.service.submit(context('synthetic-key-1', mime('', 'Changed')), principal)).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
		expect(h.send).toHaveBeenCalledOnce();
	});
	it('has exactly one reserve owner under concurrent same-key inserts', async () => {
		const repo = new SubmissionRepository(context());
		const prepared = await prepare();
		const options = { principal, key: 'racing-key', prepared, envelope, result: {} };
		const results = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.reserve({ ...options, id: `race-${i}` })));
		expect(results.filter(item => item.created)).toHaveLength(1);
		expect(new Set(results.map(item => item.row.id)).size).toBe(1);
	});
	it('does not require a raw store, even if an obsolete injected store would fail', async () => {
		const storage = { putObj: vi.fn().mockRejectedValue(new Error('private upstream details')) };
		const h = harness({ storage });
		const result = await h.service.submit(context(), principal);
		expect(result).toMatchObject({ state: 'sent', retryable: false, acceptance: 'channel_accepted' });
		expect(h.send).toHaveBeenCalledOnce();
		expect(storage.putObj).not.toHaveBeenCalled();
	});
	it('rechecks revocation after D1 reservation, before entering the business send path', async () => {
		const authorize = vi.fn().mockRejectedValue(new GatewayError(401, 'SESSION_INVALID', 'Revoked'));
		const h = harness({ authorize });
		const result = await h.service.submit(context(), principal);
		expect(result).toMatchObject({ state: 'failed', code: 'SESSION_INVALID' });
		expect(h.send).not.toHaveBeenCalled();
	});
	it('rechecks revocation after persisting dispatch intent and prevents the provider call', async () => {
		const provider = vi.fn();
		const authorize = vi.fn().mockResolvedValueOnce(principal).mockResolvedValueOnce(principal).mockRejectedValue(new GatewayError(401, 'SESSION_INVALID', 'Revoked'));
		const h = harness({ authorize, send: async (_c, _p, _u, execution) => { await execution.onAttempt(envelope.rcpt_to, 'provider'); provider(); } });
		const result = await h.service.submit(context(), principal);
		expect(result.state).toBe('failed');
		expect(provider).not.toHaveBeenCalled();
		expect(result.recipients.every(item => item.state === 'rejected')).toBe(true);
	});
	it('keeps ambiguous outcomes unknown and duplicate/status requests never send again', async () => {
		const send = vi.fn(async (_c, _p, _u, execution) => { await execution.onAttempt(envelope.rcpt_to, 'provider'); throw new Error('connection lost after DATA'); });
		const h = harness({ send });
		const result = await h.service.submit(context(), principal);
		expect(result).toMatchObject({ state: 'unknown', retryable: false, requires_reconciliation: true, acceptance: null });
		expect((await h.service.submit(context(), principal)).state).toBe('unknown');
		expect((await h.service.byKey(context(), principal, 'synthetic-key-1')).state).toBe('unknown');
		expect(send).toHaveBeenCalledOnce();
	});
	it('does not claim success when provider acceptance is followed by failed Sent bookkeeping', async () => {
		const h = harness({ send: async (_c, _p, _u, execution) => { await execution.onAttempt(envelope.rcpt_to, 'provider'); await execution.onAccepted(envelope.rcpt_to, 'provider'); throw new Error('Sent storage failed'); } });
		const result = await h.service.submit(context(), principal);
		expect(result).toMatchObject({ state: 'unknown', retryable: false, acceptance: null });
	});
	it('records partial internal acceptance honestly and never marks the whole submission retryable or sent', async () => {
		const h = harness({ send: async (_c, _p, _u, execution) => {
			await execution.onAttempt([envelope.rcpt_to[0]], 'internal');
			await execution.onAccepted([envelope.rcpt_to[0]], 'internal');
			await execution.onRejected(envelope.rcpt_to.slice(1), 'INTERNAL_REJECTED');
			await execution.onSentSaved(42);
		} });
		const result = await h.service.submit(context(), principal);
		expect(result).toMatchObject({ state: 'failed', retryable: false, acceptance: null });
		expect(result.recipients.map(item => item.state)).toEqual(['accepted', 'rejected', 'rejected']);
		expect((await h.service.listForWeb(context(), 9, 7))[0].partial).toBe(true);
	});
	it('stale sending records become unknown for reconciliation, never an executable queue', async () => {
		const repo = new SubmissionRepository(context());
		const prepared = await prepare();
		const reserved = await repo.reserve({ id: 'stale-id', principal, key: 'stale-key', prepared, envelope, result: {} });
		await env.SUBMISSION_TEST_DB.prepare('UPDATE gateway_submissions SET updated_at=? WHERE id=?').bind('2020-01-01T00:00:00.000Z', reserved.row.id).run();
		const h = harness();
		expect((await h.service.byKey(context(), principal, 'stale-key')).state).toBe('unknown');
		expect(h.send).not.toHaveBeenCalled();
	});
	it('scopes status to both mailbox and user and hides transferred accounts from management listing', async () => {
		const h = harness();
		const result = await h.service.submit(context(), principal);
		await expect(h.service.get(context(), { ...principal, accountId: '8' }, result.id)).rejects.toMatchObject({ status: 404 });
		await expect(h.service.get(context(), { ...principal, userId: '10' }, result.id)).rejects.toMatchObject({ status: 404 });
		await env.SUBMISSION_TEST_DB.prepare('UPDATE account SET user_id=10 WHERE account_id=7').run();
		expect(await h.service.listForWeb(context(), 9, 7)).toEqual([]);
	});
});
