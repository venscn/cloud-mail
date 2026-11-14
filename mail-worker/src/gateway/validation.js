import { fail } from './errors.js';

export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const MAX_RAW_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_JSON_BYTES = 8192;
export const FLAG_BITS = new Map([['\\Seen', 1], ['\\Answered', 2], ['\\Flagged', 4], ['\\Deleted', 8], ['\\Draft', 16]]);
export const OPERATIONS = ['mail.read', 'mail.write', 'mail.send'];
export const id = value => {
	if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400, 'INVALID_ID', 'Invalid resource identifier');
	return value;
};
export const uid = value => {
	if (typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)) value = Number(value);
	if (!Number.isInteger(value) || value < 1 || value > 4294967295) fail(400, 'INVALID_UID', 'Invalid UID');
	return value;
};
export const uidSet = (values, optional = false) => {
	if (optional && values === undefined) return null;
	if (!Array.isArray(values) || !values.length || values.length > 50 || values.some(v => typeof v !== 'number')) fail(400, 'INVALID_UIDS', 'UID set must contain 1 to 50 numbers');
	return [...new Set(values.map(uid))].sort((a, b) => a - b);
};
export const flagsMask = values => {
	if (!Array.isArray(values) || values.length > 5 || values.some(v => !FLAG_BITS.has(v))) fail(400, 'UNSUPPORTED_FLAGS', 'Only supported system flags may be stored');
	return values.reduce((mask, value) => mask | FLAG_BITS.get(value), 0);
};
export const flagsJSON = mask => [...FLAG_BITS].filter(([, bit]) => (mask & bit) !== 0).map(([name]) => name);
export const permissions = values => {
	if (!Array.isArray(values) || !values.length || values.length > 3 || values.some(v => !OPERATIONS.includes(v))) fail(400, 'INVALID_PERMISSIONS', 'Invalid application password permissions');
	return [...new Set(values)];
};
export function strictObject(value, keys, required = []) {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || required.some(k => !(k in value))) fail(400, 'INVALID_REQUEST', 'Invalid request fields');
	return value;
}
export async function readBounded(stream, maximum = MAX_MESSAGE_BYTES, declaredLength) {
	const declared = declaredLength === undefined || declaredLength === null ? null : Number(declaredLength);
	if (declared !== null && (!/^\d+$/.test(String(declaredLength)) || !Number.isSafeInteger(declared))) fail(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length');
	if (declared !== null && declared > maximum) {
		if (stream) await stream.cancel();
		fail(413, 'MESSAGE_TOO_LARGE', 'Request body exceeds the size limit');
	}
	if (!stream) {
		if (declared) fail(400, 'INVALID_CONTENT_LENGTH', 'Content-Length does not match the body');
		return new Uint8Array();
	}
	const reader = stream.getReader();
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) fail(400, 'INVALID_BODY', 'A binary body is required');
			length += value.byteLength;
			if (length > maximum) {
				await reader.cancel();
				fail(413, 'MESSAGE_TOO_LARGE', 'Request body exceeds the size limit');
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	if (declared !== null && declared !== length) fail(400, 'INVALID_CONTENT_LENGTH', 'Content-Length does not match the body');
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}
export async function readJSON(c, keys, required = []) {
	if ((c.req.header('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
	const bytes = await readBounded(c.req.raw.body, MAX_JSON_BYTES, c.req.header('Content-Length'));
	let value;
	try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
	catch { fail(400, 'INVALID_JSON', 'Invalid JSON body'); }
	return strictObject(value, keys, required);
}
export function pageLimit(value, max = 200) {
	if (value === undefined) return max;
	if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > max) fail(400, 'INVALID_LIMIT', 'Invalid page size');
	return Number(value);
}
export function name(value, max = 200) {
	if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value) || new TextEncoder().encode(value).length > 512) fail(400, 'INVALID_NAME', 'Invalid name');
	return value;
}
export function mailboxName(value) {
	value = name(value);
	if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.startsWith('#')) fail(400, 'INVALID_NAME', 'Only flat mailbox names are supported');
	return value;
}
export function internalDate(value) {
	if (value === undefined || value === null) return new Date().toISOString();
	if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'INVALID_DATE', 'A valid RFC3339 internal date is required');
	return new Date(value).toISOString();
}
export function idempotencyKey(value) {
	if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) fail(400, 'INVALID_IDEMPOTENCY_KEY', 'A bounded ASCII idempotency key is required');
	return value;
}
export const placeholders = values => values.map(() => '?').join(',');
export async function sha256(value) {
	if (typeof value === 'string') value = new TextEncoder().encode(value);
	return [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function randomToken(bytes = 32) {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export function base64url(bytes) {
	let text = '';
	for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(text).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export function unbase64url(value) {
	if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400, 'INVALID_CURSOR', 'Invalid cursor');
	try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
	catch { fail(400, 'INVALID_CURSOR', 'Invalid cursor'); }
}
