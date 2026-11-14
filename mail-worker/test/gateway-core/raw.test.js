import { afterEach, describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
import { createSyntheticEnvironment } from './sqlite-adapter.js';
import { createCredential, createSession, requireGatewayAuth } from '../../src/gateway/auth.js';
import { advanceBackfill, listMailboxes, listMessages } from '../../src/gateway/store.js';
import { persistRaw, recordRawForEmail, reconstructLegacy, freezeLegacyEmail, readPrivateRaw, rawObjectResponse, sentFingerprints, recordSentCopy } from '../../src/gateway/raw.js';
import { MAX_RAW_MESSAGE_BYTES, readBounded, sha256 } from '../../src/gateway/validation.js';
// Settings are an integration boundary; no production settings or SMTP runtime is loaded.
vi.mock('../../src/service/setting-service', () => ({ default: { query: vi.fn().mockResolvedValue({}) } }));
import storageService from '../../src/service/r2-service.js';

// Only the existing attachment-storage boundary is substituted when needed;
// all reconstruction, metadata, integrity and response code is production code.
import { isPrivateObjectKey } from '../../src/gateway/private-objects.js';

const environments = [];
afterEach(() => { for (const env of environments.splice(0)) env.db.close(); vi.restoreAllMocks(); });
const encoder = new TextEncoder();
const MIME = encoder.encode('From: sender@example.test\r\nTo: alice@example.test\r\nSubject: Immutable\r\nMessage-ID: <immutable@example.test>\r\n\r\nExact body\r\n');
const context = (env, headers = {}) => ({ env, req: { header: name => new Headers(headers).get(name) ?? undefined } });
async function setup() {
	const env = await createSyntheticEnvironment(); environments.push(env);
	return { env, c: context(env) };
}
function legacy(env, overrides = {}) {
	const emailId = Number(env.db.sqlite.prepare(`INSERT INTO email(account_id,user_id,send_email,name,to_email,to_name,subject,text,content,create_time)
 VALUES(1,1,'sender@example.test','Sender','alice@example.test','Alice','Historical','Plain body','<p>HTML</p>','2020-02-03 04:05:06') RETURNING email_id`).get().email_id);
	for (const [key, value] of Object.entries(overrides)) {
		if (!['subject','name','content','text','status'].includes(key)) throw new Error('Unexpected fixture override');
		env.db.sqlite.prepare(`UPDATE email SET ${key}=? WHERE email_id=?`).run(value, emailId);
	}
	return env.db.sqlite.prepare('SELECT * FROM email WHERE email_id=?').get(emailId);
}
function attachment(env, email, value = {}) {
	return env.db.sqlite.prepare(`INSERT INTO attachments(email_id,account_id,user_id,key,filename,mime_type,size,type,content_id)
 VALUES(?,1,1,?,?,?,?,?,?) RETURNING att_id`).get(email.email_id, value.key || 'legacy/object', value.filename || 'file.bin', value.mimeType || 'application/octet-stream', value.size ?? 4, value.type ?? 0, value.cid || '').att_id;
}
async function reader(f) {
	const credential = await createCredential(f.c, 1, { accountId: 1, name: 'Offline raw', permissions: ['mail.read'] });
	const session = await createSession(f.c, { mailbox_address: 'alice@example.test', app_password: credential.password });
	const c = context(f.env, { Authorization: `Bearer ${session.session_token}` });
	const principal = await requireGatewayAuth(c);
	await advanceBackfill(c, principal);
	const inbox = (await listMailboxes(c, principal)).find(mailbox => mailbox.name === 'INBOX');
	return { c, principal, inbox };
}

describe('deterministic reconstruction and immutable MIME', () => {
	it('round-trips quoted ASCII subjects without adding escapes and encodes Unicode headers/filenames', async () => {
		const f = await setup();
		const subject = 'He said "hello" \\ path';
		const email = legacy(f.env, { subject, name: '发送者名字', content: '<img src="{{domain}}legacy/object"><img src="https://legacy.example.test/legacy/object">' });
		const filename = "附件 O'Reilly (1).bin";
		attachment(f.env, email, { filename, type: 1, cid: '<inline@example.test>' });
		const content = Uint8Array.of(0, 255, 128, 10);
		const objectReader = vi.fn(async () => content);
		const first = await reconstructLegacy(f.c, email, objectReader);
		expect(await reconstructLegacy(f.c, email, objectReader)).toEqual(first);
		const text = new TextDecoder().decode(first);
		expect(text).toContain('X-CMG-Reconstructed: yes\r\n');
		expect(text).toContain('X-CMG-Reconstruction-Version: 1\r\n');
		expect(text).toContain("filename*=UTF-8''%E9%99%84%E4%BB%B6%20O%27Reilly%20%281%29.bin");
		const parsed = await PostalMime.parse(first);
		expect(parsed.subject).toBe(subject);
		expect(parsed.from.name).toBe('发送者名字');
		expect(parsed.date).toBe('2020-02-03T04:05:06.000Z');
		expect(parsed.html).toContain('cid:inline@example.test');
		expect(parsed.html).not.toMatch(/legacy\/object|legacy\.example/);
		expect(parsed.attachments[0].filename).toBe(filename);
		expect(new Uint8Array(parsed.attachments[0].content)).toEqual(content);
	});
	it('escapes quoted ASCII display names without escaping an unstructured subject', async () => {
		const f = await setup();
		const label = 'Sender "quoted" \\ path';
		const email = legacy(f.env, { name: label, subject: label });
		const bytes = await reconstructLegacy(f.c, email);
		const parsed = await PostalMime.parse(bytes);
		expect(parsed.from.name).toBe(label);
		expect(parsed.subject).toBe(label);
		expect(new TextDecoder().decode(bytes)).toContain(`Subject: ${label}\r\n`);
	});
	it('folds long Unicode subjects at valid encoded-word boundaries and strips header injection', async () => {
		const f = await setup();
		const subject = '离线重建邮件🙂'.repeat(20);
		const email = legacy(f.env, { subject, name: 'Safe\r\nBcc: attacker@example.test\x00' });
		const bytes = await reconstructLegacy(f.c, email);
		const text = new TextDecoder().decode(bytes);
		expect(text).not.toContain('\r\nBcc:');
		for (const line of text.split('\r\n').filter(line => line.includes('=?UTF-8?B?'))) expect(line.length).toBeLessThan(90);
		expect((await PostalMime.parse(bytes)).subject).toBe(subject);
	});
	it('rejects too many or oversized historical attachments before loading object bytes', async () => {
		const f = await setup(); const email = legacy(f.env); const objectReader = vi.fn();
		attachment(f.env, email, { size: MAX_RAW_MESSAGE_BYTES + 1 });
		await expect(reconstructLegacy(f.c, email, objectReader)).rejects.toMatchObject({ status: 413 });
		expect(objectReader).not.toHaveBeenCalled();
		f.env.db.sqlite.exec('DELETE FROM attachments');
		for (let i = 0; i < 101; i++) attachment(f.env, email);
		await expect(reconstructLegacy(f.c, email, objectReader)).rejects.toMatchObject({ status: 422, code: 'LEGACY_MESSAGE_UNSUPPORTED' });
		expect(objectReader).not.toHaveBeenCalled();
	});
	it('records only reconstruction metadata, never uploads MIME and detects later content changes', async () => {
		const f = await setup(); const email = legacy(f.env);
		const put = vi.spyOn(f.env.r2, 'put');
		const expected = await reconstructLegacy(f.c, email);
		const raw = await recordRawForEmail(f.c, { emailId: email.email_id, accountId: 1 });
		expect(raw).toMatchObject({ source: 'reconstructed', object_key: `legacy:${email.email_id}`, size: expected.byteLength, sha256: await sha256(expected) });
		expect(await recordRawForEmail(f.c, { emailId: email.email_id, accountId: 1 })).toEqual(raw);
		expect(put).not.toHaveBeenCalled();
		expect(f.env.r2.objects.size).toBe(0);
		delete f.env.r2;
		expect(await readPrivateRaw(f.c, raw)).toEqual(expected);
		expect(expected).not.toEqual(MIME);
		f.env.db.sqlite.prepare('UPDATE email SET text=? WHERE email_id=?').run('Changed existing body', email.email_id);
		await expect(readPrivateRaw(f.c, raw)).rejects.toMatchObject({ status: 409, code: 'MESSAGE_CHANGED' });
		await expect(recordRawForEmail(f.c, { emailId: email.email_id, accountId: 1 })).rejects.toMatchObject({ status: 409, code: 'MESSAGE_CHANGED' });
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_raw').get().n).toBe(1);
		expect(f.env.db.sqlite.prepare('SELECT raw_id FROM gateway_email_raw').get().raw_id).toBe(raw.id);
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_email_raw').get().n).toBe(1);
	});
	it('will not bind reconstruction metadata to a reassigned legacy message', async () => {
		const f = await setup(); const email = legacy(f.env);
		f.env.db.sqlite.prepare('UPDATE email SET user_id=2 WHERE email_id=?').run(email.email_id);
		await expect(recordRawForEmail(f.c, { emailId: email.email_id, accountId: 1 })).rejects.toMatchObject({ status: 404 });
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_email_raw').get().n).toBe(0);
	});
	it('discloses per-message oversize/unavailable metadata without blocking a SQL-only INBOX snapshot', async () => {
		const f = await setup(); const oversized = legacy(f.env); const unavailable = legacy(f.env); legacy(f.env);
		attachment(f.env, oversized, { size: MAX_RAW_MESSAGE_BYTES + 1 });
		await expect(freezeLegacyEmail(f.c, oversized.email_id, 1)).rejects.toMatchObject({ code: 'RAW_TOO_LARGE', status: 413 });
		attachment(f.env, unavailable, { key: 'missing/historical-file' });
		vi.spyOn(storageService, 'getObj').mockResolvedValue(null);
		delete f.env.r2;
		await expect(freezeLegacyEmail(f.c, unavailable.email_id, 1)).rejects.toMatchObject({ code: 'RAW_UNAVAILABLE', status: 503 });
		const r = await reader(f);
		const snapshot = await listMessages(r.c, r.principal, r.inbox.id, {});
		expect(snapshot.messages).toHaveLength(3);
		expect(snapshot.messages.map(message => message.raw_error)).toEqual(['RAW_TOO_LARGE','RAW_UNAVAILABLE','RAW_NOT_FROZEN']);
		expect(snapshot.messages.every(message => !message.raw_available && message.size === 0 && message.size_is_estimate)).toBe(true);
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_raw_leases').get().n).toBe(0);
		await expect(advanceBackfill(r.c, r.principal, { retryUnavailable: true })).resolves.toMatchObject({ ready: true });
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_raw_failures').get().n).toBe(0);
	});
	it('holds a bounded deployment-wide reconstruction lease and reclaims an expired lease', async () => {
		const f = await setup(); const email = legacy(f.env);
		f.env.db.sqlite.prepare('INSERT INTO gateway_raw_leases(account_id,email_id,token,expires_at) VALUES(2,999,?,?)').run('synthetic-other-request', Date.now() + 120000);
		await expect(freezeLegacyEmail(f.c, email.email_id, 1)).rejects.toMatchObject({ status: 503, code: 'RAW_PREPARING', retryable: true });
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_raw_failures').get().n).toBe(0);
		f.env.db.sqlite.exec('UPDATE gateway_raw_leases SET expires_at=1');
		await expect(freezeLegacyEmail(f.c, email.email_id, 1)).resolves.toMatchObject({ source: 'reconstructed' });
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_raw_leases WHERE account_id=1').get().n).toBe(0);
	});
	it('bounds concurrent reconstruction and releases the isolate guard after attachment failure', async () => {
		const f = await setup(); const email = legacy(f.env);
		attachment(f.env, email);
		let entered, release;
		const started = new Promise(resolve => { entered = resolve; });
		const blocked = new Promise((resolve, reject) => { release = reject; });
		const first = reconstructLegacy(f.c, email, () => { entered(); return blocked; });
		const failed = expect(first).rejects.toThrow('synthetic unavailable attachment');
		await started;
		await expect(reconstructLegacy(f.c, email, async () => Uint8Array.of(1))).rejects.toMatchObject({ status: 503, code: 'RAW_PREPARING', retryable: true });
		release(new Error('synthetic unavailable attachment'));
		await failed;
		await expect(reconstructLegacy(f.c, email, async () => Uint8Array.of(1))).resolves.toBeInstanceOf(Uint8Array);
	});
	it('records Sent hashes only without a raw mapping or any storage binding', async () => {
		const f = await setup(); const email = legacy(f.env);
		const put = vi.spyOn(f.env.r2, 'put');
		delete f.env.r2;
		await recordSentCopy(f.c, { emailId: email.email_id, accountId: 1, bytes: MIME, submissionId: 'hash-only-sent' });
		const saved = f.env.db.sqlite.prepare('SELECT * FROM gateway_sent_copies').get();
		expect(saved).toMatchObject({ email_id: email.email_id, payload_hash: await sha256(MIME) });
		expect(saved.content_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(saved.envelope_hash).toMatch(/^[0-9a-f]{64}$/);
		for (const table of ['gateway_raw', 'gateway_email_raw']) expect(f.env.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
		expect(put).not.toHaveBeenCalled();
	});
	it.each(['append', 'submission', 'received'])('rejects new %s MIME persistence instead of creating replacement storage', async source => {
		const f = await setup(); const put = vi.spyOn(f.env.r2, 'put');
		await expect(persistRaw(f.c, { accountId: 1, bytes: MIME, source })).rejects.toMatchObject({ status: 501, code: 'APPEND_UNSUPPORTED' });
		expect(put).not.toHaveBeenCalled();
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_raw').get().n).toBe(0);
	});
	it('does not deduplicate a Sent message by Message-ID or subject alone', async () => {
		const envelope = { mail_from: 'sender@example.test', rcpt_to: ['alice@example.test'] };
		const first = await sentFingerprints(MIME, envelope);
		const changed = await sentFingerprints(encoder.encode(new TextDecoder().decode(MIME).replace('Exact body', 'Changed body')), envelope);
		expect(changed.parsed.messageId).toBe(first.parsed.messageId);
		expect(changed.payloadHash).not.toBe(first.payloadHash);
		expect(changed.contentHash).not.toBe(first.contentHash);
		expect(changed.envelopeHash).toBe(first.envelopeHash);
		const differentRecipient = await sentFingerprints(MIME, { ...envelope, rcpt_to: ['bob@example.test'] });
		expect(differentRecipient.envelopeHash).not.toBe(first.envelopeHash);
	});
});

describe('reconstructed raw responses, bounds and public-key rejection', () => {
	it('streams exact full/range/suffix bytes with private MIME headers and rejects invalid multi-ranges', async () => {
		const f = await setup(); const email = legacy(f.env);
		const MIME = await reconstructLegacy(f.c, email);
		const raw = await recordRawForEmail(f.c, { emailId: email.email_id, accountId: 1 });
		delete f.env.r2;
		const full = await rawObjectResponse(f.c, raw);
		expect(full.status).toBe(200); expect(new Uint8Array(await full.arrayBuffer())).toEqual(MIME);
		expect(full.headers.get('Cache-Control')).toBe('private, no-store');
		expect(full.headers.get('Content-Type')).toBe('message/rfc822');
		expect(full.headers.get('X-CMG-Raw-Source')).toBe('reconstructed');
		expect(full.headers.get('Content-Length')).toBe(String(MIME.byteLength));
		expect(raw.size).toBe(MIME.byteLength);
		expect(raw.sha256).toBe(await sha256(MIME));
		expect(full.headers.get('ETag')).toBe(`"${raw.sha256}"`);
		for (const [range, expected, start, end] of [['bytes=2-5', MIME.slice(2, 6), 2, 5], ['bytes=-4', MIME.slice(-4), MIME.length - 4, MIME.length - 1], [`bytes=${MIME.length - 4}-9999`, MIME.slice(-4), MIME.length - 4, MIME.length - 1]]) {
			const response = await rawObjectResponse(context(f.env, { Range: range }), raw);
			expect(response.status).toBe(206); expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
			expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${MIME.length}`);
		}
		for (const range of ['bytes=1-2,4-5','bytes=-0','bytes=99999-','bytes=5-2','bytes=9007199254740992-','items=1-2']) {
			const response = await rawObjectResponse(context(f.env, { Range: range }), raw);
			expect(response.status).toBe(416); expect(response.headers.get('Content-Range')).toBe(`bytes */${MIME.length}`);
		}
	});
	it('fails closed on wrong size/hash, non-legacy keys and removed or reassigned email', async () => {
		const f = await setup(); const email = legacy(f.env);
		const raw = await recordRawForEmail(f.c, { emailId: email.email_id, accountId: 1 });
		delete f.env.r2;
		await expect(rawObjectResponse(f.c, { ...raw, size: raw.size + 1 })).rejects.toMatchObject({ status: 409, code: 'MESSAGE_CHANGED' });
		await expect(rawObjectResponse(f.c, { ...raw, sha256: '0'.repeat(64) })).rejects.toMatchObject({ status: 409, code: 'MESSAGE_CHANGED' });
		for (const object_key of ['private-gateway/raw/1/old.eml', 'legacy/public-file', 'legacy:0']) {
			await expect(rawObjectResponse(f.c, { ...raw, object_key })).rejects.toMatchObject({ status: 503, code: 'RAW_UNAVAILABLE' });
		}
		f.env.db.sqlite.prepare('UPDATE email SET user_id=2 WHERE email_id=?').run(email.email_id);
		await expect(readPrivateRaw(f.c, raw)).rejects.toMatchObject({ status: 404 });
		f.env.db.sqlite.prepare('UPDATE email SET user_id=1,is_del=1 WHERE email_id=?').run(email.email_id);
		await expect(readPrivateRaw(f.c, raw)).rejects.toMatchObject({ status: 404 });
	});
	it('reads existing attachments through their storage abstraction without R2 or new writes', async () => {
		const f = await setup(); const email = legacy(f.env);
		attachment(f.env, email);
		delete f.env.r2;
		const content = Uint8Array.of(0, 255, 128, 10);
		const get = vi.spyOn(storageService, 'getObj').mockImplementation(async () => new Response(content));
		const put = vi.spyOn(storageService, 'putObj');
		const raw = await recordRawForEmail(f.c, { emailId: email.email_id, accountId: 1 });
		const expected = await readPrivateRaw(f.c, raw);
		expect(new Uint8Array((await PostalMime.parse(expected)).attachments[0].content)).toEqual(content);
		const response = await rawObjectResponse(context(f.env, { Range: 'bytes=0-3' }), raw);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected.slice(0, 4));
		expect(get).toHaveBeenCalledWith(f.c, 'legacy/object');
		expect(put).not.toHaveBeenCalled();
		get.mockImplementation(async () => new Response(Uint8Array.of(1, 255, 128, 10)));
		await expect(rawObjectResponse(f.c, raw)).rejects.toMatchObject({ status: 409, code: 'MESSAGE_CHANGED' });
		get.mockResolvedValue(null);
		await expect(rawObjectResponse(f.c, raw)).rejects.toMatchObject({ status: 503, code: 'LEGACY_ATTACHMENT_MISSING' });
	});
	it('reports a missing historical attachment explicitly and never records successful raw metadata', async () => {
		const f = await setup(); const email = legacy(f.env);
		attachment(f.env, email);
		const get = vi.spyOn(storageService, 'getObj').mockResolvedValue(null);
		const put = vi.spyOn(storageService, 'putObj');
		delete f.env.r2;
		await expect(recordRawForEmail(f.c, { emailId: email.email_id, accountId: 1 })).rejects.toMatchObject({ status: 503, code: 'LEGACY_ATTACHMENT_MISSING', retryable: true });
		expect(get).toHaveBeenCalledWith(f.c, 'legacy/object');
		expect(put).not.toHaveBeenCalled();
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_raw').get().n).toBe(0);
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_email_raw').get().n).toBe(0);
	});
	it('cancels over-limit or lying-length streams before accepting their bytes', async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1,2,3,4)); }, cancel });
		await expect(readBounded(stream, 3)).rejects.toMatchObject({ status: 413 }); expect(cancel).toHaveBeenCalledOnce();
		await expect(readBounded(new Response(Uint8Array.of(1,2)).body, 10, '3')).rejects.toMatchObject({ status: 400, code: 'INVALID_CONTENT_LENGTH' });
		await expect(readBounded(null, 10, '1')).rejects.toMatchObject({ status: 400 });
		await expect(readBounded(new Response('a').body, 10, '-1')).rejects.toMatchObject({ status: 400 });
	});
	it.each(['private-gateway/raw/1/x.eml','PRIVATE-GATEWAY/raw','attachments/private-gateway/raw','private-gateway\\raw','%70rivate-gateway%2Fraw','%2570rivate-gateway%252Fraw','%','\x00private-gateway/raw',null,{}])('rejects a reserved or ambiguous public object key: %s', key => {
		expect(isPrivateObjectKey(key)).toBe(true);
	});
	it('keeps ordinary legacy object names public and rejects excessive nested encoding', () => {
		expect(isPrivateObjectKey('legacy/attachments/file.png')).toBe(false);
		expect(isPrivateObjectKey('private-gateway-backup/file.png')).toBe(false);
		let key = '%2F'; for (let i = 0; i < 9; i++) key = encodeURIComponent(key);
		expect(isPrivateObjectKey(key)).toBe(true);
	});
});
