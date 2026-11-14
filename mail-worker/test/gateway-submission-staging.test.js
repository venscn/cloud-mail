import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import emailService from '../src/service/email-service';
import settingService from '../src/service/setting-service';
import { emailConst } from '../src/const/entity-const';
import { createSubmissionService } from '../src/service/gateway-submission-service';
import { applyGatewayMigration, DEFAULT_MAILBOXES } from '../src/gateway/schema';
import { requireGatewayAuth } from '../src/gateway/auth';

// Real legacy tables + real gateway migration, D1 transactions, hash metadata,
// saveSentEmail/saveSendAtt, internal delivery, cron and authorization guard. Only object/KV
// storage and the external provider acceptance boundary are synthetic.
const schema = `
CREATE TABLE user(user_id INTEGER PRIMARY KEY,email TEXT NOT NULL,type INTEGER NOT NULL DEFAULT 1,password TEXT NOT NULL DEFAULT '',salt TEXT NOT NULL DEFAULT '',status INTEGER NOT NULL DEFAULT 0,is_del INTEGER NOT NULL DEFAULT 0);
CREATE TABLE account(account_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',status INTEGER NOT NULL DEFAULT 0,is_del INTEGER NOT NULL DEFAULT 0,all_receive INTEGER DEFAULT 0,sort INTEGER DEFAULT 0,latest_email_time TEXT,create_time TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE role(role_id INTEGER PRIMARY KEY,name TEXT NOT NULL,key TEXT NOT NULL,description TEXT,ban_email TEXT NOT NULL DEFAULT '',ban_email_type INTEGER NOT NULL DEFAULT 0,avail_domain TEXT DEFAULT '',sort INTEGER,is_default INTEGER DEFAULT 0,create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,user_id INTEGER,send_count INTEGER,send_type TEXT DEFAULT 'count',account_count INTEGER);
CREATE TABLE perm(perm_id INTEGER PRIMARY KEY,perm_key TEXT,type INTEGER DEFAULT 2);
CREATE TABLE role_perm(id INTEGER PRIMARY KEY,role_id INTEGER,perm_id INTEGER);
CREATE TABLE email(email_id INTEGER PRIMARY KEY AUTOINCREMENT,send_email TEXT,name TEXT,sender_email TEXT NOT NULL DEFAULT '',account_id INTEGER NOT NULL,user_id INTEGER NOT NULL,subject TEXT,code TEXT NOT NULL DEFAULT '',text TEXT,content TEXT,cc TEXT DEFAULT '[]',bcc TEXT DEFAULT '[]',recipient TEXT,to_email TEXT NOT NULL DEFAULT '',to_name TEXT NOT NULL DEFAULT '',in_reply_to TEXT DEFAULT '',relation TEXT DEFAULT '',message_id TEXT DEFAULT '',type INTEGER NOT NULL DEFAULT 0,status INTEGER NOT NULL DEFAULT 0,resend_email_id TEXT,message TEXT,unread INTEGER NOT NULL DEFAULT 0,create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,is_del INTEGER NOT NULL DEFAULT 0);
CREATE TABLE star(star_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,email_id INTEGER NOT NULL,create_time TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE attachments(att_id INTEGER PRIMARY KEY AUTOINCREMENT,email_id INTEGER NOT NULL,account_id INTEGER NOT NULL,user_id INTEGER NOT NULL,key TEXT NOT NULL,filename TEXT,mime_type TEXT,size INTEGER,disposition TEXT,content_id TEXT,encoding TEXT,type INTEGER NOT NULL DEFAULT 0,status INTEGER NOT NULL DEFAULT 0,related TEXT,create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO role(role_id,name,key,avail_domain,send_count) VALUES(1,'Synthetic','synthetic','example.test',0);
INSERT INTO perm(perm_id,perm_key) VALUES(1,'account:query'),(2,'email:send'),(3,'email:delete');
INSERT INTO role_perm(id,role_id,perm_id) VALUES(1,1,1),(2,1,2),(3,1,3);
INSERT INTO user(user_id,email) VALUES(1,'alice@example.test'),(2,'bob@example.test');
INSERT INTO account(account_id,user_id,email,name) VALUES(1,1,'alice@example.test','aLiCe'),(2,2,'bob@example.test','Bob');
`;
const token = `cmgs_${'A'.repeat(43)}`;
const bytes = value => new TextEncoder().encode(value);
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};
let c;

beforeEach(async () => {
	const db = env.SUBMISSION_STAGING_TEST_DB;
	await db.exec(schema);
	const objects = new Map();
	c = { env: { db, domain: ['example.test'], admin: 'admin@example.test',
		kv: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
		r2: { objects, async put(key, value) { objects.set(key, value.slice()); return { key }; } }
	} };
	await applyGatewayMigration(c);
	const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(token)))].map(n => n.toString(16).padStart(2, '0')).join('');
	const now = Date.now();
	await db.batch([
		db.prepare('INSERT INTO gateway_credentials(id,user_id,account_id,name,password_hash,permissions,created_at) VALUES(?,1,1,?,?,?,?)').bind('synthetic-credential', 'Synthetic', 'not-a-live-password-hash', JSON.stringify(['mail.read', 'mail.write', 'mail.send']), now),
		db.prepare('INSERT INTO gateway_sessions(id,token_hash,credential_id,user_id,account_id,created_at,expires_at) VALUES(?,?,?,1,1,?,?)').bind('synthetic-session', hash, 'synthetic-credential', now, now + 3600000)
	]);
	vi.spyOn(settingService, 'query').mockResolvedValue({ noRecipient: 0 });
});
afterEach(() => vi.restoreAllMocks());

const attachmentContent = 'Synthetic attachment\r\n';
function request(internal, { attachment = false } = {}) {
	const recipient = internal ? 'bob@example.test' : 'outside@external.test';
	const envelope = { mail_from: 'alice@example.test', rcpt_to: [recipient] };
	const body = attachment ? [
		'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="synthetic-staging-boundary"', '',
		'--synthetic-staging-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Synthetic body',
		'--synthetic-staging-boundary', 'Content-Type: text/plain',
		'Content-Disposition: attachment; filename="synthetic.txt"', 'Content-Transfer-Encoding: base64', '',
		btoa(attachmentContent), '--synthetic-staging-boundary--', ''
	].join('\r\n') : '\r\nSynthetic body\r\n';
	const raw = `From: aLiCe <alice@example.test>\r\nTo: ${recipient}\r\nMessage-ID: <synthetic-staging@example.test>\r\nSubject: Synthetic staging\r\nDate: Sat, 14 Nov 2026 00:00:00 +0000\r\n${body}`;
	const req = new Request('https://worker.example.test/api/gateway/v1/submissions', { method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'message/rfc822', 'idempotency-key': 'synthetic-staging-key',
			'x-cmg-envelope': btoa(JSON.stringify(envelope)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }, body: raw });
	c.req = { raw: req, header: name => req.headers.get(name) };
	return recipient;
}

function actualSavingSend(internal, recipient, beforeCommit = null) {
	return vi.fn(async (context, params, _userId, execution) => {
		if (beforeCommit) {
			const commit = execution.commitEmailStatus;
			execution.commitEmailStatus = async (...args) => { await beforeCommit(...args); return commit(...args); };
		}
		if (!internal) {
			await execution.onAttempt([recipient], 'synthetic-provider');
			await execution.onAccepted([recipient], 'synthetic-provider');
		}
		const saved = await emailService.saveSentEmail(context, {
			accountId: 1, userId: 1, name: params.name, subject: params.subject, text: params.text, html: execution.html,
			sendEmail: 'alice@example.test', receiveEmail: [recipient], ccEmail: params.ccEmail, bccEmail: params.bccEmail,
			providerId: 'synthetic-provider-id', messageId: execution.messageId, sendType: 'resend', useCloudflareEmail: false,
			roleRow: { sendCount: 0 }, r2Domain: '', attachments: params.attachments, imageDataList: execution.imageDataList, execution, gatewayPendingInternal: internal
		});
		if (internal) await emailService.HandleOnSiteEmail(context, [recipient], saved, saved.attList, execution);
	});
}

async function expectPrivate() {
	const { results: rows } = await c.env.db.prepare('SELECT email_id,account_id,user_id,type,status FROM email ORDER BY email_id').all();
	expect(rows.length).toBeGreaterThan(0);
	expect(rows.every(row => row.status === emailConst.status.GATEWAY_PENDING)).toBe(true);
	expect(await c.env.db.prepare('SELECT COUNT(*) n FROM gateway_messages').first('n')).toBe(0);
	for (const row of rows) {
		expect(await emailService.selectById(c, row.email_id)).toBeUndefined();
		const listed = await emailService.list(c, { accountId: row.account_id, type: row.type, allReceive: 0, size: 10, full: 0 }, row.user_id);
		expect(listed.list).toEqual([]);
		expect(listed.total).toBe(0);
		expect(listed.latestEmail.emailId).toBe(0);
	}
	expect(await emailService.latest(c, { emailId: 0, accountId: 2, allReceive: 0 }, 2)).toEqual([]);
}

describe('gateway staging is not legacy receive recovery work', () => {
	it('creates exactly six default folders for a new account on real workerd D1', async () => {
		await c.env.db.prepare("INSERT INTO account(account_id,user_id,email,name) VALUES(3,1,'third@example.test','Third')").run();
		await applyGatewayMigration(c);
		const { results } = await c.env.db.prepare('SELECT name,special_use FROM gateway_mailboxes WHERE account_id=3 ORDER BY name').all();
		expect(results).toEqual(DEFAULT_MAILBOXES.map(([name, special_use]) => ({ name, special_use })).sort((a, b) => a.name.localeCompare(b.name)));
	});

	it.each([false, true])('keeps actual %s internal sender/recipient staging private through cron, revoke, resume and restored auth', async internal => {
		const recipient = request(internal);
		const principal = await requireGatewayAuth(c, 'mail.send');
		const arrived = deferred(), release = deferred();
		// Pause the synthetic send boundary, then execute the real guarded D1
		// commit unchanged. No raw store exists to provide a pause anymore.
		const send = actualSavingSend(internal, recipient, async (_emailId, accountId) => {
			if (Number(accountId) === (internal ? 2 : 1)) { arrived.resolve(); await release.promise; }
		});
		const service = createSubmissionService({ send });
		const pending = service.submit(c, principal);
		pending.then(async value => {
			try { await send.mock.results[0]?.value; } catch (error) { arrived.reject(error); return; }
			arrived.reject(new Error(`Submission finished before the guarded commit pause: ${value.state}`));
		}, error => arrived.reject(error));
		try {
			await arrived.promise;
			expect(await c.env.db.prepare('SELECT COUNT(*) n FROM email').first('n')).toBe(internal ? 2 : 1);
			await expectPrivate();
			await emailService.completeReceiveAll(c); // actual scheduled recovery SQL
			await expectPrivate();
			// Even a provider webhook cannot promote the private sender row.
			await emailService.updateEmailStatus(c, { resendEmailId: 'synthetic-provider-id', status: emailConst.status.DELIVERED, message: 'Synthetic event' });
			await expectPrivate();
			const table = internal ? 'gateway_sessions' : 'gateway_credentials';
			await c.env.db.prepare(`UPDATE ${table} SET revoked_at=?`).bind(Date.now()).run();
			release.resolve();
			const result = await pending;
			expect(result.state).toBe('unknown');
			expect(result.acceptance).not.toBe('channel_accepted');
			expect(result.retryable).toBe(false);
			await expectPrivate();
			await c.env.db.prepare(`UPDATE ${table} SET revoked_at=NULL`).run();
			await requireGatewayAuth(c, 'mail.send');
			await emailService.completeReceiveAll(c);
			await expectPrivate();
			// Restored authority and duplicate POST do not retry the old dispatch.
			request(internal);
			expect((await service.submit(c, principal)).state).toBe('unknown');
			expect(send).toHaveBeenCalledTimes(1);
			await expectPrivate();
		} finally { release.resolve(); await pending; }
	});

	it.each([['external', false], ['internal', true]])('keeps actual %s attachment staging private across cron and send-permission revocation', async (_label, internal) => {
		const recipient = request(internal, { attachment: true });
		const principal = await requireGatewayAuth(c, 'mail.send');
		const db = c.env.db, objects = c.env.r2.objects;
		const arrived = deferred(), release = deferred();
		const put = c.env.r2.put.bind(c.env.r2);
		c.env.r2.put = async (key, value, options) => {
			if (key.startsWith('attachments/')) { arrived.resolve(key); await release.promise; }
			return put(key, value, options);
		};
		const send = actualSavingSend(internal, recipient);
		const service = createSubmissionService({ send });
		const pending = service.submit(c, principal);
		pending.then(value => arrived.reject(new Error(`Submission finished before attachment staging (${value.state})`)), error => arrived.reject(error));
		try {
			const key = await arrived.promise;
			// The real saveSendAtt has inserted its row, but its R2 write has not
			// finished. This is earlier than the guarded commits above.
			expect(await db.prepare('SELECT count(*) AS n FROM email').first('n')).toBe(1);
			expect(await db.prepare('SELECT email_id,account_id,user_id,key,filename,mime_type,size FROM attachments').first()).toEqual({
				email_id: 1, account_id: 1, user_id: 1, key, filename: 'synthetic.txt', mime_type: 'text/plain', size: bytes(attachmentContent).length
			});
			expect(objects.has(key)).toBe(false);
			expect(await db.prepare('SELECT count(*) AS n FROM gateway_sent_copies').first('n')).toBe(0);
			await expectPrivate();
			await emailService.completeReceiveAll(c);
			await expectPrivate();
			await db.prepare('DELETE FROM role_perm WHERE role_id=1 AND perm_id=2').run();
			await expect(requireGatewayAuth(c, 'mail.send')).rejects.toMatchObject({ code: 'FORBIDDEN' });
			release.resolve();
			const result = await pending;
			// External acceptance already happened; internal delivery has not yet
			// attempted a recipient at this pause point. Neither may publish Sent.
			expect(result).toMatchObject({
				state: internal ? 'failed' : 'unknown', acceptance: null, retryable: false,
				requires_reconciliation: !internal,
				recipients: [{ address: recipient, state: internal ? 'pending' : 'accepted', code: internal ? 'NOT_ATTEMPTED' : 'CHANNEL_ACCEPTED' }]
			});
			expect(objects.get(key)).toEqual(bytes(attachmentContent));
			await emailService.completeReceiveAll(c);
			await expectPrivate();

			// A later permission repair, cron, status lookup, or duplicate POST
			// must not resume or republish this already completed attempt.
			await db.prepare('INSERT INTO role_perm(id,role_id,perm_id) VALUES(2,1,2)').run();
			await expect(requireGatewayAuth(c, 'mail.send')).resolves.toMatchObject({ accountId: '1', userId: '1' });
			await emailService.completeReceiveAll(c);
			expect(await service.get(c, principal, result.id)).toEqual(result);
			request(internal, { attachment: true });
			expect(await service.submit(c, principal)).toEqual(result);
			expect(send).toHaveBeenCalledTimes(1);
			expect(await db.prepare('SELECT count(*) AS n FROM email').first('n')).toBe(1);
			expect(await db.prepare('SELECT count(*) AS n FROM attachments').first('n')).toBe(1);
			await expectPrivate();
		} finally { release.resolve(); await pending; }
	});

	it.each([['external', false], ['internal', true]])('publishes actual %s Sent and delivery copies after authorized attachment and hash-only Sent saves', async (_label, internal) => {
		const recipient = request(internal, { attachment: true });
		const principal = await requireGatewayAuth(c, 'mail.send');
		const db = c.env.db;
		const send = actualSavingSend(internal, recipient);
		const service = createSubmissionService({ send });
		const result = await service.submit(c, principal);
		expect(send).toHaveBeenCalledTimes(1);
		await expect(send.mock.results[0].value).resolves.toBeUndefined();
		expect(result).toMatchObject({
			state: 'sent', acceptance: 'channel_accepted', retryable: false, requires_reconciliation: false,
			recipients: [{ address: recipient, state: 'accepted', code: internal ? 'INTERNAL_ACCEPTED' : 'CHANNEL_ACCEPTED' }]
		});
		const emails = (await db.prepare('SELECT email_id,account_id,user_id,type,status FROM email ORDER BY email_id').all()).results;
		expect(emails).toEqual([
			{ email_id: 1, account_id: 1, user_id: 1, type: emailConst.type.SEND, status: internal ? emailConst.status.DELIVERED : emailConst.status.SENT },
			...(internal ? [{ email_id: 2, account_id: 2, user_id: 2, type: emailConst.type.RECEIVE, status: emailConst.status.RECEIVE }] : [])
		]);
		expect((await db.prepare('SELECT submission_id,account_id,email_id FROM gateway_sent_copies').all()).results)
			.toEqual([{ submission_id: result.id, account_id: 1, email_id: 1 }]);

		const attachments = (await db.prepare('SELECT email_id,account_id,user_id,key,filename,mime_type,size FROM attachments ORDER BY email_id').all()).results;
		expect(attachments).toHaveLength(emails.length);
		for (const [index, row] of emails.entries()) {
			expect(attachments[index]).toMatchObject({
				email_id: row.email_id, account_id: row.account_id, user_id: row.user_id,
				filename: 'synthetic.txt', mime_type: 'text/plain', size: bytes(attachmentContent).length
			});
			expect(attachments[index].key).toMatch(/^attachments\//);
			expect(c.env.r2.objects.get(attachments[index].key)).toEqual(bytes(attachmentContent));
			expect(await emailService.selectById(c, row.email_id)).toMatchObject({ emailId: row.email_id, status: row.status });
			const page = await emailService.list(c, { accountId: row.account_id, type: row.type, size: 20, full: 1, allReceive: 0 }, row.user_id);
			expect(page.total).toBe(1);
			expect(page.list.map(item => item.emailId)).toEqual([row.email_id]);
			expect(page.latestEmail.emailId).toBe(row.email_id);
		}
		expect(new Set(attachments.map(row => row.key)).size).toBe(1);
		const latest = await emailService.latest(c, { emailId: 0, accountId: 2, allReceive: 0 }, 2);
		expect(latest.map(row => row.emailId)).toEqual(internal ? [2] : []);

		const projections = (await db.prepare(`SELECT m.email_id,m.account_id,m.uid,m.raw_error,m.size,b.name,r.source,r.object_key
			FROM gateway_messages m JOIN gateway_mailboxes b ON b.id=m.mailbox_id LEFT JOIN gateway_raw r ON r.id=m.raw_id ORDER BY m.email_id`).all()).results;
		expect(projections).toHaveLength(emails.length);
		for (const [index, row] of emails.entries()) {
			expect(projections[index]).toMatchObject({
				email_id: row.email_id, account_id: row.account_id, uid: 1, raw_error: null, size: 0,
				name: row.type === emailConst.type.SEND ? 'Sent' : 'INBOX', source: null, object_key: null
			});
		}

		expect(await db.prepare('SELECT count(*) n FROM gateway_raw').first('n')).toBe(0);
		expect(await db.prepare('SELECT count(*) n FROM gateway_email_raw').first('n')).toBe(0);
		expect(await db.prepare('SELECT raw_key FROM gateway_submissions').first('raw_key')).toBe('');
		expect([...c.env.r2.objects.keys()].every(key => key.startsWith('attachments/'))).toBe(true);
		const fingerprint = await db.prepare('SELECT payload_hash,content_hash,envelope_hash FROM gateway_sent_copies').first();
		for (const hash of Object.values(fingerprint)) expect(hash).toMatch(/^[a-f0-9]{64}$/);

		await emailService.completeReceiveAll(c);
		expect((await db.prepare('SELECT email_id,account_id,user_id,type,status FROM email ORDER BY email_id').all()).results).toEqual(emails);
		request(internal, { attachment: true });
		expect(await service.submit(c, principal)).toEqual(result);
		expect(send).toHaveBeenCalledTimes(1);
		expect(await db.prepare('SELECT count(*) AS n FROM gateway_messages').first('n')).toBe(emails.length);
		expect(await db.prepare('SELECT count(*) AS n FROM attachments').first('n')).toBe(emails.length);
	});

	it.each([[false, false], [true, false], [false, true], [true, true]])('sends internal=%s attachment=%s without R2 using only existing KV attachment storage', async (internal, attachment) => {
		delete c.env.r2;
		const recipient = request(internal, { attachment });
		const principal = await requireGatewayAuth(c, 'mail.send');
		const send = actualSavingSend(internal, recipient);
		const service = createSubmissionService({ send });
		const result = await service.submit(c, principal);
		expect(result).toMatchObject({ state: 'sent', acceptance: 'channel_accepted', retryable: false });
		await expect(send.mock.results[0].value).resolves.toBeUndefined();
		const objectWrites = c.env.kv.put.mock.calls.filter(([key]) => key.startsWith('attachments/'));
		expect(objectWrites).toHaveLength(attachment ? 1 : 0);
		if (attachment) expect(objectWrites[0][1]).toEqual(bytes(attachmentContent));
		expect(c.env.kv.put.mock.calls.some(([key]) => key.startsWith('private-gateway/'))).toBe(false);
		expect(await c.env.db.prepare('SELECT count(*) n FROM gateway_raw').first('n')).toBe(0);
		expect(await c.env.db.prepare('SELECT count(*) n FROM gateway_email_raw').first('n')).toBe(0);
		expect(await c.env.db.prepare('SELECT count(*) n FROM gateway_sent_copies').first('n')).toBe(1);
		request(internal, { attachment });
		expect(await service.submit(c, principal)).toEqual(result);
		expect(send).toHaveBeenCalledOnce();
	});

	it('still recovers ordinary status-6 receive rows without adopting gateway status-9 rows', async () => {
		await c.env.db.batch([
			c.env.db.prepare('INSERT INTO email(account_id,user_id,status) VALUES(1,1,?)').bind(emailConst.status.SAVING),
			c.env.db.prepare('INSERT INTO email(account_id,user_id,status) VALUES(999,1,?)').bind(emailConst.status.SAVING),
			c.env.db.prepare('INSERT INTO email(account_id,user_id,status) VALUES(1,1,?)').bind(emailConst.status.GATEWAY_PENDING)
		]);
		await emailService.completeReceiveAll(c);
		expect((await c.env.db.prepare('SELECT status FROM email ORDER BY email_id').all()).results.map(row => row.status))
			.toEqual([emailConst.status.RECEIVE, emailConst.status.NOONE, emailConst.status.GATEWAY_PENDING]);
	});
});
