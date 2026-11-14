import PostalMime from 'postal-mime';
import { fail, notFound } from './errors.js';
import { ensureGatewaySchema } from './auth.js';
import { MAX_RAW_MESSAGE_BYTES, readBounded, sha256 } from './validation.js';

export const PRIVATE_PREFIX = 'private-gateway/';
const encoder = new TextEncoder();
// Relay mode never persists another MIME copy. Existing mail/attachment storage
// remains authoritative; only reconstruction digests and sizes are recorded.
export async function persistRaw() {
	fail(501, 'APPEND_UNSUPPORTED', 'Saving new MIME copies is outside relay mode');
}
export async function captureReceivedRaw() { return false; }

export async function recordRawForEmail(c, { emailId, accountId }) {
	await ensureGatewaySchema(c);
	const email = await c.env.db.prepare(`SELECT e.* FROM email e JOIN account a ON a.account_id=e.account_id AND a.user_id=e.user_id
 WHERE e.email_id=? AND e.account_id=? AND e.is_del=0 AND e.status NOT IN(6,7,9) AND a.is_del=0`).bind(emailId, accountId).first();
	if (!email) notFound();
	const bytes = await reconstructLegacy(c, email);
	const hash = await sha256(bytes);
	const existing = await c.env.db.prepare(`SELECT r.* FROM gateway_email_raw e JOIN gateway_raw r ON r.id=e.raw_id WHERE e.email_id=? AND e.account_id=?`).bind(emailId, accountId).first();
	if (existing) {
		if (existing.sha256 !== hash) fail(409, 'MESSAGE_CHANGED', 'Existing message content changed; relay cannot return different bytes for the same UID');
		return existing;
	}
	const rawId = `${accountId}:${emailId}:${hash}:reconstructed`;
	// No content bytes, object uploads or new storage binding: metadata only.
	await c.env.db.prepare(`INSERT OR IGNORE INTO gateway_raw(id,account_id,object_key,size,sha256,source,created_at) VALUES(?,?,?,?,?,'reconstructed',?)`)
		.bind(rawId, accountId, `legacy:${emailId}`, bytes.byteLength, hash, Date.now()).run();
	await c.env.db.prepare(`INSERT OR IGNORE INTO gateway_email_raw(email_id,account_id,raw_id)
 SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM email WHERE email_id=? AND account_id=? AND user_id=? AND is_del=0 AND status NOT IN(6,7,9))`)
		.bind(emailId, accountId, rawId, emailId, accountId, email.user_id).run();
	const frozen = await c.env.db.prepare(`SELECT r.* FROM gateway_email_raw e JOIN gateway_raw r ON r.id=e.raw_id WHERE e.email_id=? AND e.account_id=?`).bind(emailId, accountId).first();
	if (!frozen) notFound();
	if (frozen.sha256 !== hash) fail(409, 'MESSAGE_CHANGED', 'Existing message content changed; relay cannot return different bytes for the same UID');
	return frozen;
}

const clean = value => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ');
const validAddress = value => /^[^\s<>@,;]+@[^\s<>@,;]+$/.test(value || '');
const mimeWord = value => {
	const text = clean(value);
	if (/^[\x20-\x7e]*$/.test(text)) return text;
	const words = [];
	let chunk = '';
	for (const character of text) {
		if (encoder.encode(chunk + character).length > 42) { words.push(`=?UTF-8?B?${toBase64(encoder.encode(chunk))}?=`); chunk = ''; }
		chunk += character;
	}
	if (chunk) words.push(`=?UTF-8?B?${toBase64(encoder.encode(chunk))}?=`);
	return words.join('\r\n ');
};
const mailbox = (address, label) => {
	address = clean(address);
	if (!validAddress(address)) return 'unknown@gateway.invalid';
	if (!label) return address;
	const encoded = mimeWord(label);
	return `${encoded.startsWith('=?') ? encoded : `"${encoded.replace(/(["\\])/g, '\\$1')}"`} <${address}>`;
};
function addressList(value) {
	let values;
	try { values = JSON.parse(value || '[]'); } catch { values = []; }
	if (!Array.isArray(values)) values = [];
	return values.filter(item => validAddress(typeof item === 'string' ? item : item?.address || item?.email)).map(item => typeof item === 'string' ? item : mailbox(item.address || item.email, item.name)).join(', ');
}
function toBase64(bytes) {
	let text = '';
	for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(text);
}
const base64Body = value => toBase64(typeof value === 'string' ? encoder.encode(value) : value).replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');
const part = (type, content, headers = []) => [`Content-Type: ${type}`, 'Content-Transfer-Encoding: base64', ...headers, '', base64Body(content)].join('\r\n');

async function legacyObject(c, key) {
	// Read only through the already configured attachment storage abstraction.
	const { default: service } = await import('../service/r2-service.js');
	const object = await service.getObj(c, key);
	if (!object) fail(503, 'LEGACY_ATTACHMENT_MISSING', 'A historical attachment is unavailable', true);
	return readBounded(object.body, MAX_RAW_MESSAGE_BYTES);
}

let reconstructionActive = false;
export async function reconstructLegacy(c, email, objectReader = legacyObject) {
	// A relay does not retain MIME blobs. Bound each isolate's reconstruction
	// working set instead of allowing parallel base64 copies of large messages.
	if (reconstructionActive) fail(503, 'RAW_PREPARING', 'MIME reconstruction is busy; retry this message', true);
	reconstructionActive = true;
	try { return await reconstructLegacyBytes(c, email, objectReader); }
	finally { reconstructionActive = false; }
}
async function reconstructLegacyBytes(c, email, objectReader) {
	const attachments = (await c.env.db.prepare('SELECT * FROM attachments WHERE email_id=? ORDER BY att_id').bind(email.email_id).all()).results;
	if (attachments.length > 100) fail(422, 'LEGACY_MESSAGE_UNSUPPORTED', 'Historical message has too many MIME parts');
	let html = email.content || '';
	const parts = [];
	let totalBytes = encoder.encode(html).length + encoder.encode(email.text || '').length;
	for (const attachment of attachments) {
		if (Number(attachment.size) > MAX_RAW_MESSAGE_BYTES || totalBytes > MAX_RAW_MESSAGE_BYTES) fail(413, 'MESSAGE_TOO_LARGE', 'Historical MIME exceeds the size limit');
		const content = await objectReader(c, attachment.key);
		totalBytes += content.byteLength;
		let cid = clean(attachment.content_id).replace(/^<|>$/g, '');
		if (!cid || /[<>\s]/.test(cid)) cid = `attachment-${attachment.att_id}@gateway.invalid`;
		const inline = attachment.type === 1 || attachment.disposition === 'inline' || Boolean(attachment.content_id);
		if (inline) {
			html = html.split(`{{domain}}${attachment.key}`).join(`cid:${cid}`);
			// Historical web content may have been expanded to a storage URL.
			const escaped = attachment.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			html = html.replace(new RegExp(`https?://[^\\s"'<>]*?${escaped}`, 'g'), `cid:${cid}`);
		}
		const filename = encodeURIComponent(clean(attachment.filename || 'attachment')).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
		const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(attachment.mime_type || '') ? attachment.mime_type : 'application/octet-stream';
		parts.push(part(type, content, [`Content-Disposition: ${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`, ...(inline ? [`Content-ID: <${cid}>`] : [])]));
	}
	const seed = (await sha256(`legacy:${email.account_id}:${email.email_id}`)).slice(0, 24);
	const alternative = `cmg_alt_${seed}`;
	const mixed = `cmg_mix_${seed}`;
	const body = [`--${alternative}`, part('text/plain; charset=UTF-8', email.text || ''), ...(html ? [`--${alternative}`, part('text/html; charset=UTF-8', html)] : []), `--${alternative}--`, ''].join('\r\n');
	const dateValue = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(email.create_time) ? `${email.create_time.replace(' ', 'T')}Z` : email.create_time;
	const date = new Date(dateValue);
	const headers = [
		`From: ${mailbox(email.send_email, email.name)}`,
		`To: ${addressList(email.recipient) || mailbox(email.to_email, email.to_name)}`,
		...(addressList(email.cc) ? [`Cc: ${addressList(email.cc)}`] : []),
		...(addressList(email.bcc) ? [`Bcc: ${addressList(email.bcc)}`] : []),
		`Subject: ${mimeWord(email.subject)}`,
		`Date: ${Number.isFinite(date.getTime()) ? date.toUTCString() : 'Thu, 01 Jan 1970 00:00:00 GMT'}`,
		`Message-ID: ${/^<[^<>\s]+>$/.test(email.message_id || '') ? email.message_id : `<reconstructed-${seed}@gateway.invalid>`}`,
		...(email.in_reply_to && /^<[^<>\s]+>$/.test(email.in_reply_to) ? [`In-Reply-To: ${email.in_reply_to}`] : []),
		...(email.relation ? [`References: ${clean(email.relation)}`] : []),
		'MIME-Version: 1.0', 'X-CMG-Reconstructed: yes', 'X-CMG-Reconstruction-Version: 1',
		`Content-Type: multipart/${parts.length ? 'mixed' : 'alternative'}; boundary="${parts.length ? mixed : alternative}"`
	];
	const content = parts.length ? [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alternative}"`, '', body, ...parts.flatMap(value => [`--${mixed}`, value]), `--${mixed}--`, ''].join('\r\n') : body;
	const bytes = encoder.encode(`${headers.join('\r\n')}\r\n\r\n${content}`);
	if (bytes.byteLength > MAX_RAW_MESSAGE_BYTES) fail(413, 'MESSAGE_TOO_LARGE', 'Historical MIME exceeds the size limit');
	return bytes;
}

export async function freezeLegacyEmail(c, emailId, accountId) {
	const email = await c.env.db.prepare(`SELECT e.* FROM email e JOIN account a ON a.account_id=e.account_id AND a.user_id=e.user_id
 WHERE e.email_id=? AND e.account_id=? AND e.is_del=0 AND e.status NOT IN(6,7,9) AND a.is_del=0`).bind(emailId, accountId).first();
	if (!email) return null; // Concurrent web deletion: the next readiness check restarts safely.
	const existing = await c.env.db.prepare('SELECT raw_id FROM gateway_email_raw WHERE email_id=? AND account_id=?').bind(emailId, accountId).first();
	if (existing) return existing;
	const previous = await c.env.db.prepare('SELECT code FROM gateway_raw_failures WHERE email_id=? AND account_id=?').bind(emailId, accountId).first();
	if (previous?.code === 'RAW_TOO_LARGE') fail(413, 'RAW_TOO_LARGE', 'Historical MIME exceeds the gateway raw limit');
	// Serialize initial size/hash registration across the deployment. Every
	// reconstruction, including subsequent reads, also takes the isolate-local
	// memory admission guard above. UID backfill never downloads attachments.
	const token = crypto.randomUUID();
	const now = Date.now();
	const lease = await c.env.db.prepare(`INSERT INTO gateway_raw_leases(account_id,email_id,token,expires_at)
 SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM gateway_raw_leases WHERE expires_at>?)
 ON CONFLICT(account_id) DO UPDATE SET email_id=excluded.email_id,token=excluded.token,expires_at=excluded.expires_at
 WHERE gateway_raw_leases.expires_at<=? RETURNING token`).bind(accountId, emailId, token, now + 120000, now, now).first();
	if (!lease) fail(503, 'RAW_PREPARING', 'Historical MIME preparation is busy; retry this message', true);
	try {
		// Another request may have frozen the same message before we got the lease.
		const frozen = await c.env.db.prepare('SELECT raw_id FROM gateway_email_raw WHERE email_id=? AND account_id=?').bind(emailId, accountId).first();
		if (frozen) return frozen;
		return await recordRawForEmail(c, { emailId, accountId });
	} catch (error) {
		const code = error?.status === 413 ? 'RAW_TOO_LARGE' : 'RAW_UNAVAILABLE';
		// A failed message is explicit metadata, not a permanently failing account
		// backfill. Do not overwrite a concurrently successful immutable mapping.
		await c.env.db.prepare(`INSERT INTO gateway_raw_failures(email_id,account_id,code,size,created_at)
 SELECT ?,?,?,0,? WHERE EXISTS(SELECT 1 FROM email WHERE email_id=? AND account_id=? AND user_id=? AND is_del=0 AND status NOT IN(6,7,9))
 AND NOT EXISTS(SELECT 1 FROM gateway_email_raw WHERE email_id=? AND account_id=?)
 ON CONFLICT(email_id) DO UPDATE SET code=excluded.code,created_at=excluded.created_at`).bind(emailId, accountId, code, Date.now(), emailId, accountId, email.user_id, emailId, accountId).run();
		fail(code === 'RAW_TOO_LARGE' ? 413 : 503, code, code === 'RAW_TOO_LARGE' ? 'Historical MIME exceeds the gateway raw limit' : 'Historical MIME could not be prepared', code !== 'RAW_TOO_LARGE');
	} finally {
		await c.env.db.prepare('DELETE FROM gateway_raw_leases WHERE account_id=? AND token=?').bind(accountId, token).run();
	}
}

const normalized = value => String(value || '').replace(/\r\n/g, '\n').normalize('NFC');
const flatten = list => (list || []).flatMap(item => item.group ? flatten(item.group) : item.address ? [item.address.toLowerCase()] : []);
export async function sentFingerprints(bytes, envelope) {
	let parsed;
	try { parsed = await PostalMime.parse(bytes); } catch { fail(400, 'INVALID_MIME', 'MIME message could not be parsed'); }
	if ((parsed.attachments?.length || 0) > 100) fail(400, 'TOO_MANY_PARTS', 'MIME has too many attachments');
	const files = [];
	for (const attachment of parsed.attachments || []) files.push({ name: attachment.filename || '', type: attachment.mimeType || '', cid: attachment.contentId || '', hash: await sha256(attachment.content) });
	const from = parsed.from?.address?.toLowerCase() || '';
	const recipients = [...new Set(envelope?.rcpt_to || [...flatten(parsed.to), ...flatten(parsed.cc), ...flatten(parsed.bcc)])].map(value => value.toLowerCase()).sort();
	const sender = (envelope?.mail_from || from).toLowerCase();
	return { parsed, payloadHash: await sha256(bytes), envelopeHash: await sha256(JSON.stringify({ mail_from: sender, rcpt_to: recipients })),
		contentHash: await sha256(JSON.stringify({ from, to: flatten(parsed.to).sort(), cc: flatten(parsed.cc).sort(), subject: normalized(parsed.subject), text: normalized(parsed.text), html: normalized(parsed.html), files })) };
}
export async function recordSentCopy(c, { emailId, accountId, bytes, envelope, submissionId }) {
	const fingerprint = await sentFingerprints(bytes, envelope);
	await c.env.db.prepare(`INSERT OR IGNORE INTO gateway_sent_copies(submission_id,account_id,email_id,payload_hash,content_hash,envelope_hash,created_at)
 VALUES(?,?,?,?,?,?,?)`).bind(submissionId, accountId, emailId, fingerprint.payloadHash, fingerprint.contentHash, fingerprint.envelopeHash, Date.now()).run();
}

export async function readPrivateRaw(c, raw) {
	if (!raw || !/^legacy:[1-9]\d*$/.test(raw.object_key)) fail(503, 'RAW_UNAVAILABLE', 'Message is not backed by existing mail storage', true);
	const emailId = raw.object_key.slice(7);
	const email = await c.env.db.prepare(`SELECT e.* FROM email e JOIN account a ON a.account_id=e.account_id AND a.user_id=e.user_id
 WHERE e.email_id=? AND e.account_id=? AND e.is_del=0 AND e.status NOT IN(6,7,9) AND a.is_del=0`).bind(emailId, raw.account_id).first();
	if (!email) notFound();
	const bytes = await reconstructLegacy(c, email);
	if (bytes.byteLength !== raw.size || await sha256(bytes) !== raw.sha256) fail(409, 'MESSAGE_CHANGED', 'Existing message content changed; relay cannot return different bytes for the same UID');
	return bytes;
}

const rawHeaders = raw => ({ 'Content-Type': 'message/rfc822', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'X-CMG-Raw-Source': raw.source, ETag: `"${raw.sha256}"` });
function byteRange(value, size) {
	if (!value) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(value);
	if (!match || (!match[1] && !match[2])) return null;
	let start, end;
	if (!match[1]) {
		const length = Number(match[2]);
		if (!Number.isSafeInteger(length) || length < 1) return null;
		start = Math.max(0, size - length); end = size - 1;
	} else {
		start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
		end = Math.min(end, size - 1);
	}
	return end < start ? null : { start, end, offset: start, length: end - start + 1 };
}
const invalidRange = (raw, headers) => new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${raw.size}`, 'Content-Length': '0' } });
export function rawResponse(c, bytes, raw) {
	const headers = rawHeaders(raw);
	const range = byteRange(c.req.header('Range'), bytes.byteLength);
	if (range === null) return invalidRange({ size: bytes.byteLength }, headers);
	if (!range) return new Response(bytes, { headers: { ...headers, 'Content-Length': String(bytes.byteLength) } });
	return new Response(bytes.slice(range.start, range.end + 1), { status: 206, headers: { ...headers, 'Content-Length': String(range.length), 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}` } });
}

// Reconstruct from existing data on demand; never upload or cache MIME objects.
export async function rawObjectResponse(c, raw) {
	return rawResponse(c, await readPrivateRaw(c, raw), raw);
}
