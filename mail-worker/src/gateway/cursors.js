import { fail, notFound } from './errors.js';
import { base64url, unbase64url } from './validation.js';

export const CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const encode = new TextEncoder();
export async function accountState(c, principal) {
	const state = await c.env.db.prepare(`SELECT a.*,
 COALESCE((SELECT MAX(seq) FROM gateway_changes x WHERE x.account_id=a.account_id),a.cursor_floor) AS max_seq
 FROM gateway_accounts a WHERE a.account_id=?`).bind(principal.accountId).first();
	if (!state) notFound();
	return state;
}
async function key(state, usage) {
	return crypto.subtle.importKey('raw', encode.encode(state.cursor_secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
export async function signCursor(principal, state, kind, fields = {}, expiry = Date.now() + CURSOR_TTL_MS) {
	const payload = base64url(encode.encode(JSON.stringify({ v: 1, k: kind, a: principal.accountId, u: principal.userId, exp: expiry, ...fields })));
	const signature = await crypto.subtle.sign('HMAC', await key(state, 'sign'), encode.encode(payload));
	return `${payload}.${base64url(new Uint8Array(signature))}`;
}
export async function verifyCursor(principal, state, kind, token) {
	if (typeof token !== 'string' || token.length > 2048) fail(400, 'INVALID_CURSOR', 'Invalid cursor');
	const pieces = token.split('.');
	if (pieces.length !== 2) fail(400, 'INVALID_CURSOR', 'Invalid cursor');
	let payload;
	try {
		const signature = unbase64url(pieces[1]);
		if (signature.length !== 32 || !await crypto.subtle.verify('HMAC', await key(state, 'verify'), signature, encode.encode(pieces[0]))) fail(400, 'INVALID_CURSOR', 'Invalid cursor');
		payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unbase64url(pieces[0])));
	} catch { fail(400, 'INVALID_CURSOR', 'Invalid cursor'); }
	if (payload.v !== 1 || payload.k !== kind || payload.a !== principal.accountId || payload.u !== principal.userId || !Number.isSafeInteger(payload.exp)) fail(400, 'INVALID_CURSOR', 'Invalid cursor');
	if (payload.exp <= Date.now()) fail(410, 'CURSOR_EXPIRED', 'Cursor expired; resynchronize the mailbox');
	return payload;
}
export async function assertRevision(c, principal, revision) {
	const row = await c.env.db.prepare('SELECT revision FROM gateway_accounts WHERE account_id=?').bind(principal.accountId).first();
	if (!row || row.revision !== revision) fail(409, 'SNAPSHOT_CHANGED', 'Mailbox changed; restart the snapshot', true);
}
