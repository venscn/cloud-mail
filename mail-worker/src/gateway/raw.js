import PostalMime from 'postal-mime';
import { fail, notFound } from './errors.js';
import { ensureGatewaySchema } from './auth.js';
import { MAX_MESSAGE_BYTES, MAX_RAW_MESSAGE_BYTES, readBounded, sha256 } from './validation.js';

export const PRIVATE_PREFIX = 'private-gateway/';
const encoder = new TextEncoder();
const objectStore = c => {
	if (!c.env.r2) fail(503, 'RAW_STORAGE_UNAVAILABLE', 'A private R2 binding is required', true);
	return c.env.r2;
};

export async function persistRaw(c, { accountId, bytes, source }) {
	await ensureGatewaySchema(c);
	if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > (['append', 'submission'].includes(source) ? MAX_MESSAGE_BYTES : MAX_RAW_MESSAGE_BYTES)) fail(413, 'MESSAGE_TOO_LARGE', 'MIME exceeds the size limit');
	if (!['received', 'submission', 'append', 'reconstructed'].includes(source)) throw new Error('Invalid internal raw source');
	const hash = await sha256(bytes);
	const rawId = `${accountId}:${hash}:${source}`;
	const key = `${PRIVATE_PREFIX}raw/${accountId}/${hash}.eml`;
	const existing = await c.env.db.prepare('SELECT * FROM gateway_raw WHERE id=? AND account_id=?').bind(rawId, accountId).first();
	if (existing) return existing;
	// Content-addressed object names are immutable: concurrent writes contain identical bytes.
	await objectStore(c).put(key, bytes, { sha256: hash, customMetadata: { sha256: hash }, httpMetadata: { contentType: 'message/rfc822', cacheControl: 'private, no-store' } });
	await c.env.db.prepare(`INSERT OR IGNORE INTO gateway_raw(id,account_id,object_key,size,sha256,source,created_at) VALUES(?,?,?,?,?,?,?)`).bind(rawId, accountId, key, bytes.byteLength, hash, source, Date.now()).run();
	return { id: rawId, account_id: Number(accountId), object_key: key, size: bytes.byteLength, sha256: hash, source };
}

// Ordinary web receive must remain available on pre-migration and S3/KV-only
// installations. Gateway MIME capture is an additive best-effort enhancement:
// missing capture is later disclosed as reconstructed, never as original MIME.
export async function captureReceivedRaw(c, message) {
	if (!c.env.r2?.put || !c.env.r2?.get) return false;
	try {
		await ensureGatewaySchema(c);
		await recordRawForEmail(c, { ...message, source: 'received' });
		return true;
	} catch {
		// Do not print MIME, object URLs, account data or binding error details.
		console.warn('Gateway original MIME capture unavailable; ordinary receive continues');
		return false;
	}
}

export async function recordRawForEmail(c, { emailId, accountId, bytes, source = 'received', expectedUserId = null }) {
	const existing = await c.env.db.prepare(`SELECT r.* FROM gateway_email_raw e JOIN gateway_raw r ON r.id=e.raw_id WHERE e.email_id=? AND e.account_id=?`).bind(emailId, accountId).first();
	if (existing) {
		if (existing.sha256 !== await sha256(bytes)) fail(409, 'RAW_ALREADY_FROZEN', 'The immutable message has already been frozen');
		return existing;
	}
	const raw = await persistRaw(c, { accountId, bytes, source });
	await c.env.db.prepare(`INSERT OR IGNORE INTO gateway_email_raw(email_id,account_id,raw_id)
 SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM email WHERE email_id=? AND account_id=? AND (? IS NULL OR user_id=?))`).bind(emailId, accountId, raw.id, emailId, accountId, expectedUserId, expectedUserId).run();
	const frozen = await c.env.db.prepare(`SELECT r.* FROM gateway_email_raw e JOIN gateway_raw r ON r.id=e.raw_id WHERE e.email_id=? AND e.account_id=?`).bind(emailId, accountId).first();
	if (!frozen) notFound();
	if (frozen.sha256 !== raw.sha256) fail(409, 'RAW_ALREADY_FROZEN', 'The immutable message has already been frozen');
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
	// Reuse the configured legacy S3/R2/KV abstraction; new private MIME always uses R2.
	const { default: service } = await import('../service/r2-service.js');
	const object = await service.getObj(c, key);
	if (!object) fail(503, 'LEGACY_ATTACHMENT_MISSING', 'A historical attachment is unavailable', true);
	return readBounded(object.body, MAX_RAW_MESSAGE_BYTES);
}

export async function reconstructLegacy(c, email, objectReader = legacyObject) {
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
		'MIME-Version: 1.0', 'X-CMG-Reconstructed: yes',
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
	// Reconstruction can hold base64 parts in memory. Serialize this exceptional
	// path across the D1 deployment; ordinary raw downloads are streamed and do
	// not take this lease. The UID backfill never enters this path.
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
		const bytes = await reconstructLegacy(c, email);
		return await recordRawForEmail(c, { emailId, accountId, bytes, source: 'reconstructed', expectedUserId: email.user_id });
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
	const raw = await recordRawForEmail(c, { emailId, accountId, bytes, source: 'submission' });
	const fingerprint = await sentFingerprints(bytes, envelope);
	await c.env.db.prepare(`INSERT OR IGNORE INTO gateway_sent_copies(submission_id,account_id,email_id,payload_hash,content_hash,envelope_hash,created_at)
 VALUES(?,?,?,?,?,?,?)`).bind(submissionId, accountId, emailId, fingerprint.payloadHash, fingerprint.contentHash, fingerprint.envelopeHash, Date.now()).run();
	return raw;
}

export async function readPrivateRaw(c, raw) {
	if (!raw || !raw.object_key.startsWith(PRIVATE_PREFIX)) notFound();
	const object = await objectStore(c).get(raw.object_key);
	if (!object) fail(503, 'RAW_UNAVAILABLE', 'Immutable MIME is temporarily unavailable', true);
	const bytes = await readBounded(object.body, MAX_RAW_MESSAGE_BYTES);
	if (bytes.byteLength !== raw.size || await sha256(bytes) !== raw.sha256) fail(503, 'RAW_INTEGRITY_FAILURE', 'Immutable MIME failed integrity validation');
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

// R2 validates SHA-256 on put. Its returned checksum/metadata identifies the
// immutable object, so full and single-range GETs can pass through its stream
// without making 25 MiB copies in every concurrent Worker request.
export async function rawObjectResponse(c, raw) {
	if (!raw || !raw.object_key.startsWith(PRIVATE_PREFIX)) notFound();
	if (raw.size > MAX_RAW_MESSAGE_BYTES) fail(413, 'RAW_TOO_LARGE', 'Immutable MIME exceeds the raw download limit');
	const headers = rawHeaders(raw);
	const range = byteRange(c.req.header('Range'), raw.size);
	if (range === null) return invalidRange(raw, headers);
	const object = await objectStore(c).get(raw.object_key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
	if (!object) fail(503, 'RAW_UNAVAILABLE', 'Immutable MIME is temporarily unavailable', true);
	const checksum = object.checksums?.sha256 ? [...new Uint8Array(object.checksums.sha256)].map(n => n.toString(16).padStart(2, '0')).join('') : object.customMetadata?.sha256;
	if (object.size !== raw.size || (checksum && checksum !== raw.sha256)) {
		await object.body.cancel();
		fail(503, 'RAW_INTEGRITY_FAILURE', 'Immutable MIME failed integrity validation');
	}
	if (!checksum) {
		// Compatibility with pre-checksum objects, never with guessed raw sizes.
		await object.body.cancel();
		return rawResponse(c, await readPrivateRaw(c, raw), raw);
	}
	return new Response(object.body, { status: range ? 206 : 200, headers: { ...headers, 'Content-Length': String(range ? range.length : raw.size), ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${raw.size}` } : {}) } });
}
