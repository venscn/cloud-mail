import { fail, notFound } from './errors.js';
import { mutationGuard, requireDeletionPermission } from './auth.js';
import { defaultsFor, MAX_UID } from './schema.js';
import { accountState, assertRevision, signCursor, verifyCursor, CURSOR_TTL_MS } from './cursors.js';
import { flagsJSON, flagsMask, id, uid, uidSet, mailboxName, pageLimit, placeholders, sha256, internalDate, idempotencyKey, readBounded, MAX_MESSAGE_BYTES } from './validation.js';
import { freezeLegacyEmail, rawObjectResponse, sentFingerprints } from './raw.js';

export const BACKFILL_BATCH = 500;
const visibleLegacy = `e.account_id=? AND e.user_id=? AND e.is_del=0 AND e.status NOT IN(6,7,9)
 AND NOT EXISTS(SELECT 1 FROM gateway_messages m WHERE m.email_id=e.email_id)`;
// Materialize the starting UIDNEXT BEFORE triggers allocate each ordered row.
// No MIME/attachment reads occur in backfill. The CTE and all trigger effects are
// one transactional statement, so concurrent imports cannot reuse a UID.
export const PROJECT_BATCH_SQL = `WITH candidates AS MATERIALIZED(
 SELECT e.email_id,e.account_id,b.id AS mailbox_id,b.uid_next AS base_uid,r.raw_id,f.code AS raw_error,
 COALESCE(o.size,f.size,0) AS size,(CASE WHEN e.unread=1 THEN 1 ELSE 0 END) |
 (CASE WHEN EXISTS(SELECT 1 FROM star s WHERE s.email_id=e.email_id AND s.user_id=e.user_id) THEN 4 ELSE 0 END) AS flags,
 COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',e.create_time),'1970-01-01T00:00:00.000Z') AS internal_date
 FROM email e JOIN account a ON a.account_id=e.account_id AND a.user_id=e.user_id AND a.is_del=0 AND a.status=0
 JOIN gateway_mailboxes b ON b.account_id=e.account_id AND b.name=CASE WHEN e.type=1 THEN 'Sent' ELSE 'INBOX' END
 LEFT JOIN gateway_email_raw r ON r.email_id=e.email_id AND r.account_id=e.account_id
 LEFT JOIN gateway_raw o ON o.id=r.raw_id
 LEFT JOIN gateway_raw_failures f ON f.email_id=e.email_id AND f.account_id=e.account_id
 WHERE ${visibleLegacy} ORDER BY e.email_id LIMIT ${BACKFILL_BATCH}
),ranked AS(SELECT *,ROW_NUMBER() OVER(PARTITION BY mailbox_id ORDER BY email_id)-1 AS offset FROM candidates)
 INSERT INTO gateway_messages(id,account_id,mailbox_id,uid,email_id,raw_id,raw_error,size,flags,internal_date)
 SELECT lower(hex(randomblob(16))),account_id,mailbox_id,base_uid+offset,email_id,raw_id,raw_error,size,flags,internal_date
 FROM ranked WHERE base_uid+offset<4294967295 ORDER BY mailbox_id,email_id`;

// Projection is an internal prerequisite for either read OR write operations;
// a write-only app credential must not be forced to acquire mail.read.
const projectionOperation = principal => principal.permissions.includes('mail.read') ? 'mail.read' : 'mail.write';
export async function initializeAccount(c, principal) {
	const guard = mutationGuard(c, principal, { operation: projectionOperation(principal) });
	await c.env.db.batch([guard.start,
		c.env.db.prepare('INSERT OR IGNORE INTO gateway_accounts(account_id) VALUES(?)').bind(principal.accountId),
		c.env.db.prepare(defaultsFor('?')).bind(principal.accountId), guard.end]);
}
export async function advanceBackfill(c, principal, { retryUnavailable = false } = {}) {
	await initializeAccount(c, principal);
	const guard = mutationGuard(c, principal, { operation: projectionOperation(principal) });
	const statements = [guard.start];
	if (retryUnavailable) statements.push(c.env.db.prepare(`DELETE FROM gateway_raw_failures WHERE email_id IN(
 SELECT email_id FROM gateway_raw_failures WHERE account_id=? ORDER BY email_id LIMIT 50)`).bind(principal.accountId));
	statements.push(c.env.db.prepare(PROJECT_BATCH_SQL).bind(principal.accountId, principal.userId), guard.end);
	const results = await c.env.db.batch(statements);
	const remaining = await c.env.db.prepare(`SELECT COUNT(*) AS count FROM email e WHERE ${visibleLegacy}`).bind(principal.accountId, principal.userId).first();
	if (remaining.count) {
		const exhausted = await c.env.db.prepare(`SELECT 1 FROM email e JOIN gateway_mailboxes b ON b.account_id=e.account_id
 AND b.name=CASE WHEN e.type=1 THEN 'Sent' ELSE 'INBOX' END WHERE ${visibleLegacy} AND b.uid_next>=4294967295 LIMIT 1`).bind(principal.accountId, principal.userId).first();
		if (exhausted) fail(507, 'UID_EXHAUSTED', 'Mailbox UID space is exhausted');
	}
	const unavailable = await c.env.db.prepare('SELECT COUNT(*) AS count FROM gateway_messages WHERE account_id=? AND raw_id IS NULL').bind(principal.accountId).first();
	await pruneChanges(c, principal);
	return { ready: remaining.count === 0, processed: results[statements.length - 2].meta.changes, remaining: remaining.count, raw_pending: unavailable.count };
}
export async function ensureReady(c, principal) {
	const progress = await advanceBackfill(c, principal);
	if (!progress.ready) fail(503, 'BACKFILL_IN_PROGRESS', 'Mailbox UID backfill is in progress; retry or advance authorized maintenance', true);
}
export async function pruneChanges(c, principal) {
	// At most 1000 old tombstones per call. Cursor floor advances in the same
	// transaction; a valid-but-pruned cursor returns 410, never silently skips.
	const guard = mutationGuard(c, principal, { operation: projectionOperation(principal) });
	await c.env.db.batch([guard.start,
		c.env.db.prepare(`UPDATE gateway_accounts SET cursor_floor=MAX(cursor_floor,COALESCE((SELECT MAX(seq) FROM (
 SELECT seq FROM gateway_changes WHERE account_id=? AND created_at<? ORDER BY seq LIMIT 1000)),cursor_floor)) WHERE account_id=?`).bind(principal.accountId, Date.now() - CURSOR_TTL_MS, principal.accountId),
		c.env.db.prepare('DELETE FROM gateway_changes WHERE account_id=? AND seq<=(SELECT cursor_floor FROM gateway_accounts WHERE account_id=?)').bind(principal.accountId, principal.accountId), guard.end
	]);
}
function mailboxJSON(row) {
	return { id: String(row.id), name: row.name, delimiter: '/', special_use: row.special_use || null, subscribed: !!row.subscribed,
		uid_validity: row.id, uid_next: row.uid_next, highest_mod_seq: row.highest_mod_seq, messages: row.messages || 0, unseen: row.unseen || 0 };
}
export function messageJSON(row) {
	const available = !!row.raw_source && !row.raw_source.startsWith('unavailable:');
	const result = { uid: row.uid, flags: flagsJSON(row.flags), size: row.size, internal_date: row.internal_date, mod_seq: row.mod_seq,
		raw_source: available ? row.raw_source : 'unavailable', raw_available: available };
	if (!available) Object.assign(result, { raw_error: row.raw_source?.startsWith('unavailable:') ? row.raw_source.slice(12) : 'RAW_NOT_FROZEN',
		size_is_estimate: true, raw_retryable: row.raw_source !== 'unavailable:RAW_TOO_LARGE' });
	return result;
}
const messageColumns = `m.*,COALESCE(r.source,CASE WHEN m.raw_error IS NOT NULL THEN 'unavailable:'||m.raw_error END) AS raw_source`;
const mailboxColumns = `b.*,(SELECT COUNT(*) FROM gateway_messages m WHERE m.mailbox_id=b.id) AS messages,
 (SELECT COUNT(*) FROM gateway_messages m WHERE m.mailbox_id=b.id AND (m.flags & 1)=0) AS unseen`;
export async function ownedMailbox(c, principal, mailboxId) {
	mailboxId = id(mailboxId);
	const row = await c.env.db.prepare(`SELECT ${mailboxColumns} FROM gateway_mailboxes b WHERE b.id=? AND b.account_id=?`).bind(mailboxId, principal.accountId).first();
	if (!row) notFound();
	return row;
}
export async function listMailboxes(c, principal) {
	const state = await accountState(c, principal);
	const rows = await c.env.db.prepare(`SELECT ${mailboxColumns} FROM gateway_mailboxes b WHERE b.account_id=? ORDER BY b.id`).bind(principal.accountId).all();
	await assertRevision(c, principal, state.revision);
	return rows.results.map(mailboxJSON);
}
export async function createMailbox(c, principal, value) {
	const name = mailboxName(value.name);
	if (value.subscribed !== undefined && typeof value.subscribed !== 'boolean') fail(400, 'INVALID_REQUEST', 'subscribed must be boolean');
	const state = await accountState(c, principal);
	const count = await c.env.db.prepare('SELECT COUNT(*) AS count FROM gateway_mailboxes WHERE account_id=?').bind(principal.accountId).first();
	if (count.count >= 100) fail(409, 'MAILBOX_LIMIT', 'Mailbox limit reached');
	const guard = mutationGuard(c, principal, { revision: state.revision });
	const results = await c.env.db.batch([guard.start,
		c.env.db.prepare('INSERT INTO gateway_mailboxes(account_id,name,subscribed) VALUES(?,?,?) RETURNING *').bind(principal.accountId, name, value.subscribed === false ? 0 : 1), guard.end]);
	return mailboxJSON(results[1].results[0]);
}
export async function updateMailbox(c, principal, mailboxId, value) {
	if (!Object.keys(value).length || (value.subscribed !== undefined && typeof value.subscribed !== 'boolean')) fail(400, 'INVALID_REQUEST', 'Invalid mailbox fields');
	const state = await accountState(c, principal);
	const mailbox = await ownedMailbox(c, principal, mailboxId);
	const name = value.name === undefined ? mailbox.name : mailboxName(value.name);
	if (mailbox.special_use && name !== mailbox.name) fail(403, 'SPECIAL_MAILBOX', 'Special mailbox names are fixed');
	const guard = mutationGuard(c, principal, { revision: state.revision });
	const results = await c.env.db.batch([guard.start,
		c.env.db.prepare('UPDATE gateway_mailboxes SET name=?,subscribed=? WHERE id=? AND account_id=? RETURNING *').bind(name, value.subscribed === undefined ? mailbox.subscribed : Number(value.subscribed), mailbox.id, principal.accountId), guard.end]);
	return mailboxJSON(results[1].results[0]);
}
export async function deleteMailbox(c, principal, mailboxId) {
	requireDeletionPermission(principal);
	const state = await accountState(c, principal);
	const mailbox = await ownedMailbox(c, principal, mailboxId);
	if (mailbox.special_use) fail(403, 'SPECIAL_MAILBOX', 'Special mailboxes cannot be deleted');
	if (mailbox.messages) fail(409, 'MAILBOX_NOT_EMPTY', 'Expunge or move messages before deleting the mailbox');
	const guard = mutationGuard(c, principal, { revision: state.revision, deletion: true });
	await c.env.db.batch([guard.start, c.env.db.prepare('DELETE FROM gateway_mailboxes WHERE id=? AND account_id=?').bind(mailbox.id, principal.accountId), guard.end]);
	return { deleted: true };
}
export async function listMessages(c, principal, mailboxId, query) {
	const mailbox = await ownedMailbox(c, principal, mailboxId);
	const limit = pageLimit(query.limit);
	const state = await accountState(c, principal);
	let snapshot, token = query.snapshot, after = 0;
	if (token) {
		snapshot = await verifyCursor(principal, state, 'snapshot', token);
		if (snapshot.b !== String(mailbox.id) || !Number.isSafeInteger(snapshot.r) || !Number.isSafeInteger(snapshot.seq)) fail(400, 'INVALID_CURSOR', 'Snapshot does not match the mailbox');
		if (snapshot.r !== state.revision) fail(409, 'SNAPSHOT_CHANGED', 'Mailbox changed; restart the snapshot', true);
	} else {
		if (query.cursor) fail(400, 'INVALID_CURSOR', 'A page cursor requires its snapshot');
		snapshot = { b: String(mailbox.id), r: state.revision, seq: state.max_seq, exp: Date.now() + CURSOR_TTL_MS };
		token = await signCursor(principal, state, 'snapshot', { b: snapshot.b, r: snapshot.r, seq: snapshot.seq }, snapshot.exp);
	}
	if (query.cursor) {
		const page = await verifyCursor(principal, state, 'page', query.cursor);
		if (page.b !== snapshot.b || page.r !== snapshot.r || page.seq !== snapshot.seq || page.exp !== snapshot.exp || !Number.isInteger(page.after) || page.after < 1 || page.after >= MAX_UID) fail(400, 'INVALID_CURSOR', 'Page cursor does not match the snapshot');
		after = page.after;
	}
	const rows = (await c.env.db.prepare(`SELECT ${messageColumns} FROM gateway_messages m LEFT JOIN gateway_raw r ON r.id=m.raw_id
 WHERE m.account_id=? AND m.mailbox_id=? AND m.uid>? ORDER BY m.uid LIMIT ?`).bind(principal.accountId, mailbox.id, after, limit + 1).all()).results;
	await assertRevision(c, principal, snapshot.r);
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	return { messages: page.map(messageJSON), snapshot: token,
		next_cursor: hasMore ? await signCursor(principal, state, 'page', { b: snapshot.b, r: snapshot.r, seq: snapshot.seq, after: page.at(-1).uid }, snapshot.exp) : null,
		cursor: await signCursor(principal, state, 'changes', { seq: snapshot.seq }, snapshot.exp) };
}
export async function changes(c, principal, query) {
	const limit = pageLimit(query.limit);
	const state = await accountState(c, principal);
	let after = state.max_seq;
	if (query.cursor) {
		const payload = await verifyCursor(principal, state, 'changes', query.cursor);
		if (!Number.isSafeInteger(payload.seq) || payload.seq < 0 || payload.seq > state.max_seq) fail(400, 'INVALID_CURSOR', 'Invalid change position');
		if (payload.seq < state.cursor_floor) fail(410, 'CURSOR_EXPIRED', 'Change history expired; resynchronize the mailbox');
		after = payload.seq;
	}
	const rows = (await c.env.db.prepare('SELECT * FROM gateway_changes WHERE account_id=? AND seq>? ORDER BY seq LIMIT ?').bind(principal.accountId, after, limit + 1).all()).results;
	const page = rows.slice(0, limit);
	const last = page.length ? page.at(-1).seq : after;
	return { changes: page.map(row => ({ seq: row.seq, type: row.type, mailbox_id: String(row.mailbox_id), uid: row.uid,
		...(row.type === 'expunged' ? {} : { message: messageJSON({ ...row, mod_seq: row.seq }) }) })),
		cursor: await signCursor(principal, state, 'changes', { seq: last }), has_more: rows.length > limit };
}
async function selectedMessages(c, principal, mailbox, uids) {
	const rows = await c.env.db.prepare(`SELECT ${messageColumns} FROM gateway_messages m LEFT JOIN gateway_raw r ON r.id=m.raw_id
 WHERE m.account_id=? AND m.mailbox_id=? AND m.uid IN(${placeholders(uids)}) ORDER BY m.uid`).bind(principal.accountId, mailbox.id, ...uids).all();
	if (rows.results.length !== uids.length) notFound();
	return rows.results;
}
export async function rawMessage(c, principal, mailboxId, messageUid) {
	const mailbox = await ownedMailbox(c, principal, mailboxId);
	const rows = await selectedMessages(c, principal, mailbox, [uid(messageUid)]);
	let message = rows[0];
	if (!message.raw_id) {
		if (!message.email_id) fail(503, 'RAW_UNAVAILABLE', 'Raw message is unavailable', true);
		if (message.raw_error === 'RAW_TOO_LARGE') fail(413, 'RAW_TOO_LARGE', 'Historical MIME exceeds the raw read limit');
		await freezeLegacyEmail(c, message.email_id, principal.accountId);
		message = (await selectedMessages(c, principal, mailbox, [message.uid]))[0];
	}
	const raw = await c.env.db.prepare('SELECT * FROM gateway_raw WHERE id=? AND account_id=?').bind(message.raw_id, principal.accountId).first();
	if (!raw) fail(503, 'RAW_UNAVAILABLE', 'Raw message is unavailable', true);
	return rawObjectResponse(c, raw);
}
export async function updateFlags(c, principal, mailboxId, value) {
	const uids = uidSet(value.uids), mask = flagsMask(value.flags);
	if (!['add', 'remove', 'set'].includes(value.mode)) fail(400, 'INVALID_MODE', 'Invalid flag mutation mode');
	const state = await accountState(c, principal);
	const mailbox = await ownedMailbox(c, principal, mailboxId);
	const messages = await selectedMessages(c, principal, mailbox, uids);
	const deletion = !!(mask & 8) || (value.mode === 'set' && messages.some(m => (m.flags & 8) !== (mask & 8)));
	if (deletion) requireDeletionPermission(principal);
	const guard = mutationGuard(c, principal, { revision: state.revision, deletion });
	const expression = value.mode === 'add' ? 'flags | ?' : value.mode === 'remove' ? 'flags & ~?' : '?';
	await c.env.db.batch([guard.start, c.env.db.prepare(`UPDATE gateway_messages SET flags=${expression}
 WHERE account_id=? AND mailbox_id=? AND uid IN(${placeholders(uids)})`).bind(mask, principal.accountId, mailbox.id, ...uids), guard.end]);
	return { messages: (await selectedMessages(c, principal, mailbox, uids)).map(messageJSON) };
}
export async function expunge(c, principal, mailboxId, value) {
	requireDeletionPermission(principal);
	const requested = uidSet(value.uids, true);
	const state = await accountState(c, principal);
	const mailbox = await ownedMailbox(c, principal, mailboxId);
	let messages;
	if (requested) messages = (await selectedMessages(c, principal, mailbox, requested)).filter(m => (m.flags & 8) !== 0);
	else messages = (await c.env.db.prepare('SELECT * FROM gateway_messages WHERE mailbox_id=? AND account_id=? AND (flags & 8)!=0 ORDER BY uid LIMIT 51').bind(mailbox.id, principal.accountId).all()).results;
	if (messages.length > 50) fail(400, 'BATCH_TOO_LARGE', 'Use an explicit UID set of at most 50 messages');
	if (!messages.length) return { uids: [] };
	const guard = mutationGuard(c, principal, { revision: state.revision, deletion: true });
	const legacyIds = messages.filter(m => m.email_id !== null).map(m => m.email_id);
	const statements = [guard.start];
	if (legacyIds.length) statements.push(c.env.db.prepare(`UPDATE email SET is_del=1 WHERE user_id=? AND account_id=? AND email_id IN(${placeholders(legacyIds)})`).bind(principal.userId, principal.accountId, ...legacyIds));
	statements.push(c.env.db.prepare(`DELETE FROM gateway_messages WHERE account_id=? AND id IN(${placeholders(messages)})`).bind(principal.accountId, ...messages.map(m => m.id)), guard.end);
	await c.env.db.batch(statements);
	return { uids: messages.map(m => m.uid) };
}
export async function copyMove(c, principal, mailboxId, value, move) {
	if (!move) fail(501, 'COPY_UNSUPPORTED', 'Creating independent mail copies is outside relay mode');
	const uids = uidSet(value.uids);
	if (move) requireDeletionPermission(principal);
	const source = await ownedMailbox(c, principal, mailboxId);
	const destination = await ownedMailbox(c, principal, id(value.destination_id));
	if (source.id === destination.id) fail(400, 'SAME_MAILBOX', 'Source and destination mailboxes must differ');
	// MOVE changes only the existing message's mailbox mapping. Do not download
	// attachments or reconstruct MIME merely to move a message.
	const state = await accountState(c, principal);
	const messages = await selectedMessages(c, principal, source, uids);
	if (messages.some(m => !m.email_id)) fail(501, 'MOVE_UNSUPPORTED', 'Relay mode requires an existing Cloud Mail message');
	const currentDestination = await ownedMailbox(c, principal, String(destination.id));
	const guard = mutationGuard(c, principal, { revision: state.revision, deletion: move, mailboxId: destination.id, allocations: messages.length });
	const statements = [guard.start];
	const destinationUids = messages.map((_, i) => currentDestination.uid_next + i);
	if (move) statements.push(c.env.db.prepare(`DELETE FROM gateway_messages WHERE account_id=? AND id IN(${placeholders(messages)})`).bind(principal.accountId, ...messages.map(m => m.id)));
	// A single bounded JSON table avoids 50 per-row D1 calls and the 100 SQL
	// parameter limit without sacrificing the transaction or ordered UID checks.
	const payload = messages.map(m => ({ id: crypto.randomUUID(), email_id: move ? m.email_id : null, raw_id: m.raw_id, size: m.size, flags: m.flags, internal_date: m.internal_date }));
	statements.push(c.env.db.prepare(`INSERT INTO gateway_messages(id,account_id,mailbox_id,uid,email_id,raw_id,size,flags,internal_date)
 SELECT json_extract(j.value,'$.id'),?,?,?+CAST(j.key AS INTEGER),json_extract(j.value,'$.email_id'),
 json_extract(j.value,'$.raw_id'),json_extract(j.value,'$.size'),json_extract(j.value,'$.flags'),json_extract(j.value,'$.internal_date')
 FROM json_each(?) j ORDER BY CAST(j.key AS INTEGER)`).bind(principal.accountId, destination.id, currentDestination.uid_next, JSON.stringify(payload)), guard.end);
	await c.env.db.batch(statements);
	return { uid_validity: destination.id, source_uids: uids, destination_uids: destinationUids };
}
export async function append(c, principal, mailboxId) {
	const mailbox = await ownedMailbox(c, principal, mailboxId);
	if ((c.req.header('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'message/rfc822') fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be message/rfc822');
	const key = idempotencyKey(c.req.header('Idempotency-Key'));
	const flagHeader = c.req.header('X-CMG-Flags');
	let flags = [];
	if (flagHeader !== undefined) {
		if (flagHeader.length > 256) fail(400, 'UNSUPPORTED_FLAGS', 'Invalid flags header');
		try { flags = JSON.parse(flagHeader); } catch { fail(400, 'UNSUPPORTED_FLAGS', 'Invalid flags header'); }
	}
	const mask = flagsMask(flags);
	if (mask & 8) requireDeletionPermission(principal);
	const suppliedDate = c.req.header('X-CMG-Internal-Date');
	const date = internalDate(suppliedDate);
	const bytes = await readBounded(c.req.raw.body, MAX_MESSAGE_BYTES, c.req.header('Content-Length'));
	if (!bytes.byteLength) fail(400, 'INVALID_MIME', 'MIME must not be empty');
	const payloadHash = await sha256(bytes);
	const requestHash = await sha256(JSON.stringify([String(mailbox.id), payloadHash, mask, suppliedDate ? date : null]));
	const previous = await c.env.db.prepare('SELECT * FROM gateway_appends WHERE account_id=? AND idempotency_key=?').bind(principal.accountId, key).first();
	if (previous) {
		if (previous.request_hash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request');
		return { uid_validity: previous.mailbox_id, uid: previous.uid };
	}
	let sentCopy = null;
	if (mailbox.special_use === '\\Sent') {
		const fingerprint = await sentFingerprints(bytes);
		sentCopy = await c.env.db.prepare(`SELECT s.submission_id AS id,m.uid FROM gateway_sent_copies s JOIN gateway_messages m ON m.email_id=s.email_id
 WHERE s.account_id=? AND m.account_id=? AND m.mailbox_id=? AND s.consumed_at IS NULL AND s.created_at>?
 AND s.envelope_hash=? AND s.payload_hash=? ORDER BY s.created_at LIMIT 1`).bind(principal.accountId, principal.accountId, mailbox.id, Date.now() - 3600000, fingerprint.envelopeHash, fingerprint.payloadHash).first();
	}
	if (!sentCopy) fail(501, 'APPEND_UNSUPPORTED', 'Relay mode can acknowledge an existing Sent copy but does not create new MIME storage');
	const state = await accountState(c, principal);
	const currentMailbox = await ownedMailbox(c, principal, String(mailbox.id));
	const destinationUid = sentCopy ? sentCopy.uid : currentMailbox.uid_next;
	const guard = mutationGuard(c, principal, { revision: state.revision, deletion: !!(mask & 8), mailboxId: mailbox.id, allocations: sentCopy ? 0 : 1 });
	const statements = [guard.start];
	if (sentCopy) {
		// The candidate was read before asynchronous MIME work. Validate its
		// one-time state INSIDE this transaction as well as the account revision.
		const claim = crypto.randomUUID();
		statements.push(c.env.db.prepare(`INSERT INTO gateway_write_guard(id,authorized,revision_ok,capacity_ok)
 SELECT ?,1,EXISTS(SELECT 1 FROM gateway_sent_copies s JOIN gateway_messages m ON m.email_id=s.email_id
 WHERE s.submission_id=? AND s.consumed_at IS NULL AND s.account_id=? AND m.account_id=? AND m.mailbox_id=? AND m.uid=?),1`).bind(claim, sentCopy.id, principal.accountId, principal.accountId, mailbox.id, destinationUid));
		statements.push(c.env.db.prepare('DELETE FROM gateway_write_guard WHERE id=?').bind(claim));
		statements.push(c.env.db.prepare('UPDATE gateway_sent_copies SET consumed_at=? WHERE submission_id=? AND consumed_at IS NULL').bind(Date.now(), sentCopy.id));
		statements.push(c.env.db.prepare('UPDATE gateway_messages SET flags=flags | ? WHERE mailbox_id=? AND uid=? AND account_id=?').bind(mask, mailbox.id, destinationUid, principal.accountId));
		// Serializes one-time consumption even when the requested flags were unchanged.
		statements.push(c.env.db.prepare('UPDATE gateway_accounts SET revision=revision+1 WHERE account_id=?').bind(principal.accountId));
	}
	statements.push(c.env.db.prepare(`INSERT INTO gateway_appends(account_id,idempotency_key,request_hash,mailbox_id,uid,created_at)
 VALUES(?,?,?,?,?,?)`).bind(principal.accountId, key, requestHash, mailbox.id, destinationUid, Date.now()), guard.end);
	await c.env.db.batch(statements);
	return { uid_validity: mailbox.id, uid: destinationUid };
}
