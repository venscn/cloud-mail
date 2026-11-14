// Independent protocol API: never passes through (or exempts) the web JWT app.
import { Hono } from 'hono';
import { createSession, requireGatewayAuth, logout } from '../gateway/auth.js';
import { errorResponse, fail } from '../gateway/errors.js';
import { readJSON, MAX_MESSAGE_BYTES, MAX_RAW_MESSAGE_BYTES, OPERATIONS } from '../gateway/validation.js';
import * as store from '../gateway/store.js';
import submissionService from '../service/gateway-submission-service.js';

const gateway = new Hono().basePath('/api/gateway/v1');
gateway.onError((error, c) => errorResponse(c, error));
gateway.notFound(c => errorResponse(c, { status: 404, code: 'NOT_FOUND' }));
gateway.use('*', async (c, next) => {
	c.set('requestId', crypto.randomUUID());
	c.header('Cache-Control', 'no-store');
	c.header('X-Content-Type-Options', 'nosniff');
	const url = new URL(c.req.url);
	if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(426, 'TLS_REQUIRED', 'HTTPS is required');
	await next();
	// A read can await R2 or several snapshot pages. Do not return private data if
	// its credential/ownership/role was revoked while those awaits were in flight.
	if (c.get('gatewayPrincipal') && !c.get('gatewayLoggedOut') && c.res.status < 400) await requireGatewayAuth(c, c.get('gatewayOperation'));
});
function query(c, allowed) {
	const params = new URL(c.req.url).searchParams;
	if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) fail(400, 'INVALID_REQUEST', 'Invalid query fields');
	return Object.fromEntries(params);
}
async function auth(c, operation, ready = true) {
	const principal = await requireGatewayAuth(c, operation);
	c.set('gatewayPrincipal', principal);
	c.set('gatewayOperation', operation);
	if (ready) await store.ensureReady(c, principal);
	return principal;
}
const data = (c, value, status = 200) => c.json({ data: value }, status);

gateway.get('/capabilities', c => {
	query(c, []);
	return data(c, { version: 1, max_message_bytes: MAX_MESSAGE_BYTES, max_raw_message_bytes: MAX_RAW_MESSAGE_BYTES, max_recipients: 50, page_size: 200, operations: OPERATIONS });
});
gateway.post('/sessions', async c => {
	query(c, []);
	return data(c, await createSession(c, await readJSON(c, ['mailbox_address', 'app_password'], ['mailbox_address', 'app_password'])));
});
gateway.delete('/sessions/current', async c => {
	query(c, []);
	const principal = await auth(c, null, false);
	await logout(c, principal);
	c.set('gatewayLoggedOut', true);
	return data(c, { revoked: true });
});
gateway.post('/maintenance/backfill', async c => {
	query(c, []);
	const principal = await auth(c, 'mail.read', false);
	const value = await readJSON(c, ['retry_unavailable']);
	if (value.retry_unavailable !== undefined && typeof value.retry_unavailable !== 'boolean') fail(400, 'INVALID_REQUEST', 'retry_unavailable must be boolean');
	return data(c, await store.advanceBackfill(c, principal, { retryUnavailable: value.retry_unavailable === true }));
});
gateway.get('/mailboxes', async c => {
	query(c, []);
	return data(c, { mailboxes: await store.listMailboxes(c, await auth(c, 'mail.read')) });
});
gateway.post('/mailboxes', async c => {
	query(c, []);
	const principal = await auth(c, 'mail.write');
	return data(c, await store.createMailbox(c, principal, await readJSON(c, ['name', 'subscribed'], ['name'])));
});
gateway.patch('/mailboxes/:id', async c => {
	query(c, []);
	const principal = await auth(c, 'mail.write');
	return data(c, await store.updateMailbox(c, principal, c.req.param('id'), await readJSON(c, ['name', 'subscribed'])));
});
gateway.delete('/mailboxes/:id', async c => {
	query(c, []);
	return data(c, await store.deleteMailbox(c, await auth(c, 'mail.write'), c.req.param('id')));
});
gateway.get('/mailboxes/:id/messages', async c => {
	const options = query(c, ['limit', 'cursor', 'snapshot']);
	return data(c, await store.listMessages(c, await auth(c, 'mail.read'), c.req.param('id'), options));
});
gateway.get('/changes', async c => {
	const options = query(c, ['limit', 'cursor']);
	return data(c, await store.changes(c, await auth(c, 'mail.read'), options));
});
gateway.get('/mailboxes/:id/messages/:uid/raw', async c => {
	query(c, []);
	return store.rawMessage(c, await auth(c, 'mail.read'), c.req.param('id'), c.req.param('uid'));
});
gateway.post('/mailboxes/:id/messages', async c => {
	query(c, []);
	return data(c, await store.append(c, await auth(c, 'mail.write'), c.req.param('id')));
});
gateway.patch('/mailboxes/:id/flags', async c => {
	query(c, []);
	const principal = await auth(c, 'mail.write');
	return data(c, await store.updateFlags(c, principal, c.req.param('id'), await readJSON(c, ['uids', 'mode', 'flags'], ['uids', 'mode', 'flags'])));
});
gateway.post('/mailboxes/:id/expunge', async c => {
	query(c, []);
	const principal = await auth(c, 'mail.write');
	return data(c, await store.expunge(c, principal, c.req.param('id'), await readJSON(c, ['uids'])));
});
for (const operation of ['copy', 'move']) gateway.post(`/mailboxes/:id/${operation}`, async c => {
	query(c, []);
	const principal = await auth(c, 'mail.write');
	return data(c, await store.copyMove(c, principal, c.req.param('id'), await readJSON(c, ['uids', 'destination_id'], ['uids', 'destination_id']), operation === 'move'));
});
gateway.post('/submissions', async c => {
	query(c, []);
	return data(c, await submissionService.submit(c, await auth(c, 'mail.send', false)));
});
gateway.get('/submissions/by-key/:key', async c => {
	query(c, []);
	return data(c, await submissionService.byKey(c, await auth(c, 'mail.send', false), c.req.param('key')));
});
gateway.get('/submissions/:id', async c => {
	query(c, []);
	return data(c, await submissionService.get(c, await auth(c, 'mail.send', false), c.req.param('id')));
});

export default gateway;
