import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyntheticEnvironment } from './sqlite-adapter.js';
import { createCredential, createSession, requireGatewayAuth, revokeCredential } from '../../src/gateway/auth.js';
import { advanceBackfill, listMailboxes, listMessages, changes, rawMessage, updateFlags, copyMove, append, expunge, pruneChanges } from '../../src/gateway/store.js';
import { recordRawForEmail } from '../../src/gateway/raw.js';
import { accountState, signCursor } from '../../src/gateway/cursors.js';
import { applyGatewayMigration } from '../../src/gateway/schema.js';

const environments = [];
afterEach(() => { for (const env of environments.splice(0)) env.db.close(); vi.restoreAllMocks(); });
const encoder = new TextEncoder();
const MIME = encoder.encode('From: sender@example.test\r\nTo: alice@example.test\r\nMessage-ID: <synthetic@example.test>\r\nSubject: Offline only\r\n\r\nLocal bytes\r\n');
const context = (env, headers = {}, bytes) => {
	const request = new Request('https://worker.example.test/api/gateway/v1', { method: bytes ? 'POST' : 'GET', headers, ...(bytes ? { body: bytes } : {}) });
	return { env, req: { raw: request, header: name => request.headers.get(name) ?? undefined } };
};
async function setup(permissions = ['mail.read', 'mail.write']) {
	const env = await createSyntheticEnvironment(); environments.push(env);
	const c = context(env);
	const credential = await createCredential(c, 1, { accountId: 1, name: 'SQLite test', permissions });
	const session = await createSession(c, { mailbox_address: 'alice@example.test', app_password: credential.password });
	const authenticated = context(env, { authorization: `Bearer ${session.session_token}` });
	const principal = await requireGatewayAuth(authenticated, permissions[0]);
	await advanceBackfill(authenticated, principal);
	const mailboxes = await listMailboxes(authenticated, principal);
	return { env, c: authenticated, principal, credential, session, inbox: mailboxes.find(b => b.name === 'INBOX'), archive: mailboxes.find(b => b.name === 'Archive'), sent: mailboxes.find(b => b.name === 'Sent') };
}
function legacy(env, { account = 1, user = 1, status = 0, deleted = 0, type = 0, text = 'Legacy body', subject = 'Legacy subject' } = {}) {
	return Number(env.db.sqlite.prepare(`INSERT INTO email(account_id,user_id,status,is_del,type,text,subject,send_email,to_email,recipient)
 VALUES(?,?,?,?,?,?,?,'sender@example.test','alice@example.test','[{"address":"alice@example.test"}]') RETURNING email_id`).get(account, user, status, deleted, type, text, subject).email_id);
}
async function captured(fixture, options = {}) {
	const emailId = legacy(fixture.env, options);
	await recordRawForEmail(fixture.c, { emailId, accountId: 1, expectedUserId: 1, bytes: MIME });
	return fixture.env.db.sqlite.prepare('SELECT * FROM gateway_messages WHERE email_id=?').get(emailId);
}
async function appendMime(f, mailbox = f.inbox, key = 'append-synthetic-key-0001', mime = MIME, flags = []) {
	return append(context(f.env, { 'Content-Type': 'message/rfc822', 'Idempotency-Key': key, 'X-CMG-Flags': JSON.stringify(flags) }, mime), f.principal, mailbox.id);
}

describe('persistent SQLite UID/revision projection', () => {
	it('is migration-idempotent and backfills without reading MIME/R2, including oversized or broken legacy rows', async () => {
		const f = await setup();
		const ids = [legacy(f.env), legacy(f.env, { text: 'oversized placeholder' })];
		legacy(f.env, { status: 6 }); legacy(f.env, { status: 7 }); legacy(f.env, { status: 9 }); legacy(f.env, { deleted: 1 });
		f.env.r2.get = vi.fn().mockRejectedValue(new Error('Backfill must not read objects'));
		await applyGatewayMigration(f.c);
		await applyGatewayMigration(f.c);
		await advanceBackfill(f.c, f.principal);
		const first = await listMessages(f.c, f.principal, f.inbox.id, {});
		expect(first.messages.map(m => m.uid)).toEqual([1, 2]);
		expect(first.messages.every(m => m.raw_available === false && m.size_is_estimate && m.size === 0)).toBe(true);
		expect(f.env.r2.get).not.toHaveBeenCalled();
		expect(f.env.db.sqlite.prepare('SELECT email_id FROM gateway_messages ORDER BY uid').all().map(r => r.email_id)).toEqual(ids);
		const before = f.env.db.sqlite.prepare('SELECT uid_next,highest_mod_seq FROM gateway_mailboxes WHERE id=?').get(Number(f.inbox.id));
		await advanceBackfill(f.c, f.principal);
		expect(f.env.db.sqlite.prepare('SELECT uid_next,highest_mod_seq FROM gateway_mailboxes WHERE id=?').get(Number(f.inbox.id))).toEqual(before);
	});
	it('updates seen/star both directions and invalidates snapshot pages after a legacy change', async () => {
		const f = await setup(); const row = await captured(f); await captured(f);
		const page = await listMessages(f.c, f.principal, f.inbox.id, { limit: '1' });
		expect(page.next_cursor).toBeTruthy();
		await updateFlags(f.c, f.principal, f.inbox.id, { uids: [row.uid], flags: ['\\Seen', '\\Flagged'], mode: 'add' });
		expect(f.env.db.sqlite.prepare('SELECT unread FROM email WHERE email_id=?').get(row.email_id).unread).toBe(1);
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM star WHERE email_id=?').get(row.email_id).n).toBe(1);
		await expect(listMessages(f.c, f.principal, f.inbox.id, { snapshot: page.snapshot, cursor: page.next_cursor })).rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_CHANGED' });
		f.env.db.sqlite.prepare('UPDATE email SET unread=0 WHERE email_id=?').run(row.email_id);
		f.env.db.sqlite.prepare('DELETE FROM star WHERE email_id=?').run(row.email_id);
		const updated = await listMessages(f.c, f.principal, f.inbox.id, {});
		expect(updated.messages[0].flags).toEqual([]);
	});
	it('uses independent COPY instances; legacy deletion only removes the linked message and never reuses UID', async () => {
		const f = await setup(); const original = await captured(f);
		const copied = await copyMove(f.c, f.principal, f.inbox.id, { uids: [original.uid], destination_id: f.archive.id }, false);
		expect(copied.destination_uids).toEqual([1]);
		expect(f.env.db.sqlite.prepare('SELECT email_id FROM gateway_messages WHERE mailbox_id=?').get(Number(f.archive.id)).email_id).toBeNull();
		const before = await changes(f.c, f.principal, {});
		f.env.db.sqlite.prepare('UPDATE email SET is_del=1 WHERE email_id=?').run(original.email_id);
		expect((await listMessages(f.c, f.principal, f.inbox.id, {})).messages).toHaveLength(0);
		expect((await listMessages(f.c, f.principal, f.archive.id, {})).messages).toHaveLength(1);
		expect((await changes(f.c, f.principal, { cursor: before.cursor })).changes).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'expunged', uid: 1, mailbox_id: f.inbox.id })]));
		const next = await captured(f);
		expect(next.uid).toBe(2);
		expect(next.mailbox_id).toBe(Number(f.inbox.id));
	});
	it('moves linked message atomically, expunges only Deleted and records tombstones', async () => {
		const f = await setup(); const original = await captured(f);
		const moved = await copyMove(f.c, f.principal, f.inbox.id, { uids: [original.uid], destination_id: f.archive.id }, true);
		const movedRow = f.env.db.sqlite.prepare('SELECT * FROM gateway_messages').get();
		expect(movedRow.email_id).toBe(original.email_id);
		expect(movedRow.mailbox_id).toBe(Number(f.archive.id));
		expect(await expunge(f.c, f.principal, f.archive.id, { uids: moved.destination_uids })).toEqual({ uids: [] });
		await updateFlags(f.c, f.principal, f.archive.id, { uids: moved.destination_uids, flags: ['\\Deleted'], mode: 'add' });
		expect(await expunge(f.c, f.principal, f.archive.id, { uids: moved.destination_uids })).toEqual({ uids: [1] });
		expect(f.env.db.sqlite.prepare('SELECT is_del FROM email WHERE email_id=?').get(original.email_id).is_del).toBe(1);
	});
	it('APPEND is exact, idempotent, never creates legacy send mail and rejects key conflicts', async () => {
		const f = await setup();
		const first = await appendMime(f);
		expect(await appendMime(f)).toEqual(first);
		await expect(appendMime(f, f.inbox, 'append-synthetic-key-0001', encoder.encode('different'))).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM email').get().n).toBe(0);
		const response = await rawMessage(f.c, f.principal, f.inbox.id, first.uid);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(MIME);
		expect(response.headers.get('X-CMG-Raw-Source')).toBe('append');
	});
	it('write-only credentials can initialize/backfill and APPEND but cannot authenticate a read', async () => {
		const f = await setup(['mail.write']);
		legacy(f.env); await advanceBackfill(f.c, f.principal);
		expect((await appendMime(f)).uid).toBe(2);
		await expect(requireGatewayAuth(f.c, 'mail.read')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
	});
	it('transactional guard rolls back APPEND and pruning if credential is revoked immediately before the batch', async () => {
		const f = await setup(); await captured(f);
		f.env.db.sqlite.prepare('UPDATE gateway_changes SET created_at=1').run();
		const oldFloor = f.env.db.sqlite.prepare('SELECT cursor_floor FROM gateway_accounts WHERE account_id=1').get().cursor_floor;
		await revokeCredential(f.c, 1, f.credential.id);
		await expect(appendMime(f)).rejects.toThrow();
		await expect(pruneChanges(f.c, f.principal)).rejects.toThrow();
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_appends').get().n).toBe(0);
		expect(f.env.db.sqlite.prepare('SELECT cursor_floor FROM gateway_accounts WHERE account_id=1').get().cursor_floor).toBe(oldFloor);
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_changes').get().n).toBeGreaterThan(0);
	});
	it('pruning advances cursor floor atomically and rejects a valid-but-pruned cursor', async () => {
		const f = await setup(); await captured(f); await captured(f);
		const state = await accountState(f.c, f.principal);
		const cursor = await signCursor(f.principal, state, 'changes', { seq: 0 });
		f.env.db.sqlite.prepare('UPDATE gateway_changes SET created_at=1').run();
		await pruneChanges(f.c, f.principal);
		await expect(changes(f.c, f.principal, { cursor })).rejects.toMatchObject({ status: 410, code: 'CURSOR_EXPIRED' });
	});
	it('revokes old sessions and replaces UIDVALIDITY when an account changes owner', async () => {
		const f = await setup(); const row = await captured(f);
		f.env.db.sqlite.prepare('UPDATE account SET user_id=2 WHERE account_id=1').run();
		await expect(requireGatewayAuth(f.c)).rejects.toMatchObject({ status: 401, code: 'SESSION_INVALID' });
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_messages WHERE account_id=1').get().n).toBe(0);
		const newInbox = f.env.db.sqlite.prepare("SELECT id FROM gateway_mailboxes WHERE account_id=1 AND name='INBOX'").get();
		expect(newInbox.id).not.toBe(Number(f.inbox.id));
		expect(f.env.db.sqlite.prepare('SELECT user_id FROM email WHERE email_id=?').get(row.email_id).user_id).toBe(1);
	});
	it('can recapture an originally unassigned message after reassignment without cross-account raw mapping', async () => {
		const f = await setup();
		const emailId = legacy(f.env, { account: 0, user: 0, status: 7 });
		await recordRawForEmail(f.c, { emailId, accountId: 0, expectedUserId: 0, bytes: MIME });
		f.env.db.sqlite.prepare('UPDATE email SET account_id=1,user_id=1,status=0 WHERE email_id=?').run(emailId);
		expect(f.env.db.sqlite.prepare('SELECT * FROM gateway_email_raw WHERE email_id=?').get(emailId)).toBeUndefined();
		await recordRawForEmail(f.c, { emailId, accountId: 1, expectedUserId: 1, bytes: MIME });
		expect(f.env.db.sqlite.prepare('SELECT account_id FROM gateway_email_raw WHERE email_id=?').get(emailId).account_id).toBe(1);
		expect(f.env.db.sqlite.prepare('SELECT account_id FROM gateway_messages WHERE email_id=?').get(emailId).account_id).toBe(1);
	});
	it('refuses exhausted UID allocation without emitting a successful append record', async () => {
		const f = await setup();
		f.env.db.sqlite.prepare('UPDATE gateway_mailboxes SET uid_next=4294967295 WHERE id=?').run(Number(f.inbox.id));
		await expect(appendMime(f)).rejects.toThrow();
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_appends').get().n).toBe(0);
	});
});
