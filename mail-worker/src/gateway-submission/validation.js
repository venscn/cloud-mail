import PostalMime, { addressParser } from 'postal-mime';
import fileUtils from '../utils/file-utils';

export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const MAX_RECIPIENTS = 50;
export const MAX_ENVELOPE_HEADER = 24 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

// Deliberately safe messages: callers may expose these, never an upstream error.
export class SubmissionError extends Error {
	constructor(status, code, message, retryable = false) {
		super(message);
		this.name = 'SubmissionError';
		this.status = status;
		this.code = code;
		this.retryable = retryable;
	}
}

export function validateKey(value) {
	if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new SubmissionError(400, 'INVALID_IDEMPOTENCY_KEY', 'A bounded ASCII Idempotency-Key is required.');
	}
	return value;
}

export function address(value) {
	// No SMTPUTF8 capability is advertised by the gateway. Quoted local parts,
	// routes and address literals are deliberately not accepted by this API.
	if (typeof value !== 'string' || value.length > 254 || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) {
		throw new SubmissionError(400, 'INVALID_ENVELOPE', 'The envelope contains an unsupported mailbox address.');
	}
	const [local, domain] = value.split('@');
	if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.includes('..') || domain.split('.').some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
		throw new SubmissionError(400, 'INVALID_ENVELOPE', 'The envelope contains an unsupported mailbox address.');
	}
	return value.toLowerCase();
}

export function parseEnvelope(value, principal) {
	if (typeof value !== 'string' || value.length > MAX_ENVELOPE_HEADER || !/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new SubmissionError(400, 'INVALID_ENVELOPE', 'X-CMG-Envelope must be unpadded base64url JSON.');
	}
	let envelope;
	try {
		const data = value.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(data + '='.repeat((4 - data.length % 4) % 4));
		const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
		envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new SubmissionError(400, 'INVALID_ENVELOPE', 'X-CMG-Envelope must be unpadded base64url JSON.');
	}
	if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).some(key => !['mail_from', 'rcpt_to'].includes(key)) || !Array.isArray(envelope.rcpt_to) || !envelope.rcpt_to.length || envelope.rcpt_to.length > MAX_RECIPIENTS) {
		throw new SubmissionError(400, 'INVALID_ENVELOPE', 'An envelope with between 1 and 50 recipients is required.');
	}
	const mail_from = address(envelope.mail_from);
	if (mail_from !== address(principal.mailboxAddress)) {
		throw new SubmissionError(403, 'SENDER_FORBIDDEN', 'The envelope sender must be the authenticated mailbox.');
	}
	const rcpt_to = [...new Set(envelope.rcpt_to.map(address))];
	return { mail_from, rcpt_to };
}

export async function readRaw(request) {
	if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'message/rfc822') {
		throw new SubmissionError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be message/rfc822.');
	}
	const length = request.headers.get('content-length');
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_MESSAGE_BYTES)) {
		throw new SubmissionError(413, 'MESSAGE_TOO_LARGE', 'The message exceeds the permitted size.');
	}
	if (!request.body) throw new SubmissionError(400, 'INVALID_MIME', 'A complete MIME message is required.');
	const reader = request.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_MESSAGE_BYTES) {
				await reader.cancel();
				throw new SubmissionError(413, 'MESSAGE_TOO_LARGE', 'The message exceeds the permitted size.');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (!size) throw new SubmissionError(400, 'INVALID_MIME', 'A complete MIME message is required.');
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function sha256(bytes) {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeHeader(value, limit = 998) {
	if (typeof value !== 'string' || value.length > limit || /[\r\n\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
		throw new SubmissionError(400, 'INVALID_MIME', 'A message header is invalid or too large.');
	}
	return value;
}

function flatten(list = []) {
	const result = [];
	for (const item of list) {
		if (item.group) result.push(...flatten(item.group));
		else if (item.address) result.push(address(item.address));
	}
	return [...new Set(result)];
}

function headerEnd(bytes) {
	for (let i = 0; i < Math.min(bytes.length, MAX_HEADER_BYTES + 4); i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i + 4;
		if (bytes[i] === 10 && bytes[i + 1] === 10) return i + 2;
	}
	throw new SubmissionError(400, 'INVALID_MIME', 'A MIME header block of at most 64 KiB is required.');
}

// Preserve every body/attachment byte while removing Bcc (and any folded
// continuation) from the copy delivered internally. The sender's immutable Sent
// copy retains the submitted original; recipients must never receive its Bcc.
export function withoutBcc(bytes) {
	const end = headerEnd(bytes);
	const chunks = [];
	let offset = 0;
	let skip = false;
	let changed = false;
	while (offset < end) {
		let next = offset;
		while (next < end && bytes[next] !== 10) next++;
		if (next < end) next++;
		const line = bytes.subarray(offset, next);
		if (line[0] !== 32 && line[0] !== 9) {
			const name = new TextDecoder().decode(line);
			skip = /^(?:resent-)?bcc[ \t]*:/i.test(name);
		}
		if (skip) changed = true;
		else chunks.push(line);
		offset = next;
	}
	if (!changed) return bytes;
	chunks.push(bytes.subarray(end));
	const length = chunks.reduce((sum, item) => sum + item.byteLength, 0);
	const output = new Uint8Array(length);
	offset = 0;
	for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
	return output;
}

// Convert MIME to the *same* business send pipeline as the web composer. The
// immutable submitted bytes are stored separately; provider MIME is rebuilt by
// the existing channels (in particular QQ's delegated sender annotation).
export async function prepareMime(bytes, envelope, principal) {
	const end = headerEnd(bytes);
	if (end > MAX_HEADER_BYTES) throw new SubmissionError(400, 'INVALID_MIME', 'The MIME header block is too large.');
	let previous = false;
	let lines;
	try { lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)).split(/\r?\n/); }
	catch { throw new SubmissionError(400, 'INVALID_MIME', 'A MIME header contains invalid text.'); }
	for (const line of lines) {
		if (!line) continue;
		if (new TextEncoder().encode(line).byteLength > 998 || /[\r\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(line) || (/^[ \t]/.test(line) ? !previous : !/^[!-9;-~]+:/.test(line))) {
			throw new SubmissionError(400, 'INVALID_MIME', 'A MIME header line is invalid or too large.');
		}
		previous = true;
	}
	let parsed;
	try {
		parsed = await PostalMime.parse(bytes, { attachmentEncoding: 'base64' });
	} catch {
		throw new SubmissionError(400, 'INVALID_MIME', 'The MIME message could not be parsed.');
	}
	const headers = parsed.headers || [];
	const fromHeaders = headers.filter(header => header.key === 'from');
	const senderHeaders = headers.filter(header => header.key === 'sender');
	const singleIdentity = header => {
		const identities = addressParser(header.value, { flatten: true });
		return identities.length === 1 && identities[0].address && address(identities[0].address) === address(principal.mailboxAddress);
	};
	if (fromHeaders.length !== 1 || !singleIdentity(fromHeaders[0]) || senderHeaders.some(header => !singleIdentity(header))) {
		throw new SubmissionError(403, 'SENDER_FORBIDDEN', 'The From and Sender headers must identify the authenticated mailbox.');
	}
	if (headers.some(header => header.key?.startsWith('resent-')) || headers.filter(header => ['message-id', 'sender', 'subject', 'date', 'reply-to'].includes(header.key)).some((header, index, list) => list.findIndex(other => other.key === header.key) !== index)) {
		throw new SubmissionError(400, 'INVALID_MIME', 'Duplicate or resent identity headers are not supported.');
	}
	const to = flatten(parsed.to);
	const cc = flatten(parsed.cc).filter(item => !to.includes(item));
	const visible = new Set([...to, ...cc]);
	const recipients = new Set(envelope.rcpt_to);
	// Header recipients never add delivery recipients. RCPT-only addresses are
	// hidden recipients, including when no Bcc header was sent by the client.
	const receiveEmail = to.filter(item => recipients.has(item));
	const ccEmail = cc.filter(item => recipients.has(item));
	const bccEmail = envelope.rcpt_to.filter(item => !visible.has(item));
	const messageId = parsed.messageId ? safeHeader(parsed.messageId, 254) : `<${crypto.randomUUID()}@${envelope.mail_from.split('@')[1]}>`;
	if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) {
		throw new SubmissionError(400, 'INVALID_MIME', 'Message-ID must be a single bounded msg-id.');
	}
	const gatewayHeaders = {
		To: to.join(', '),
		Cc: cc.join(', '),
		'Message-ID': messageId
	};
	if (parsed.date) gatewayHeaders.Date = safeHeader(parsed.date);
	if (parsed.inReplyTo) gatewayHeaders['In-Reply-To'] = safeHeader(parsed.inReplyTo);
	if (parsed.references) gatewayHeaders.References = safeHeader(parsed.references);
	const replyTo = flatten(parsed.replyTo);
	if (replyTo.length) gatewayHeaders['Reply-To'] = replyTo.join(', ');
	const attachments = [];
	const imageDataList = [];
	if (parsed.attachments.length > 100) throw new SubmissionError(413, 'TOO_MANY_ATTACHMENTS', 'A maximum of 100 MIME attachments is supported.');
	for (const item of parsed.attachments) {
		const filename = safeHeader(item.filename || 'attachment', 255).replace(/[\\/]/g, '_');
		const mimeType = safeHeader(item.mimeType || 'application/octet-stream', 200);
		if (!/^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+$/.test(mimeType)) throw new SubmissionError(400, 'INVALID_MIME', 'An attachment media type is invalid.');
		const contentId = item.contentId ? safeHeader(item.contentId, 254).replace(/^<|>$/g, '') : undefined;
		const content = item.content;
		if (contentId) {
			const buff = fileUtils.base64ToUint8Array(content);
			imageDataList.push({
				filename, mimeType, content, contentId, buff, size: buff.byteLength,
				key: `attachments/${await sha256(buff)}${fileUtils.getExtFileName(filename)}`
			});
		} else attachments.push({ filename, type: mimeType, content });
	}
	const payloadHash = await sha256(bytes);
	const canonicalEnvelope = { mail_from: envelope.mail_from, rcpt_to: [...envelope.rcpt_to].sort() };
	const requestHash = await sha256(new TextEncoder().encode(JSON.stringify({ version: 1, payload_hash: payloadHash, envelope: canonicalEnvelope })));
	return {
		payloadHash, requestHash, messageId, imageDataList, gatewayHeaders, visibleTo: to, visibleCc: cc,
		html: parsed.html || '',
		params: {
			accountId: Number(principal.accountId), name: safeHeader(parsed.from.name || '', 200),
			sendType: 'new', manyType: 'merge', receiveEmail, ccEmail, bccEmail,
			text: parsed.text || '', content: parsed.html || '', subject: safeHeader(parsed.subject || '', 998), attachments
		}
	};
}
