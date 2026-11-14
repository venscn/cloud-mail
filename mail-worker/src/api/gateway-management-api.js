// Web management routes use the EXISTING JWT/KV authentication middleware.
// No app password or gateway session token can authorize these endpoints.
import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import { webAccounts, listCredentials, createCredential, revokeCredential } from '../gateway/auth.js';
import { fail, safeGatewayError } from '../gateway/errors.js';
import { readJSON, id } from '../gateway/validation.js';
import submissionService from '../service/gateway-submission-service.js';

function query(c, allowed = []) {
	const params = new URL(c.req.url).searchParams;
	if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) fail(400, 'INVALID_REQUEST', 'Invalid query fields');
	return Object.fromEntries(params);
}
const route = handler => async c => {
	c.header('Cache-Control', 'no-store');
	c.header('X-Content-Type-Options', 'nosniff');
	try { return c.json(result.ok(await handler(c, userContext.getUserId(c)))); }
	catch (error) { const safe = safeGatewayError(error); return c.json(result.fail(safe.message, safe.status), safe.status); }
};
app.get('/gateway/accounts', route(async (c, userId) => { query(c); return webAccounts(c, userId); }));
app.get('/gateway/app-passwords', route(async (c, userId) => { query(c); return listCredentials(c, userId); }));
app.post('/gateway/app-passwords', route(async (c, userId) => {
	query(c);
	return createCredential(c, userId, await readJSON(c, ['accountId', 'name', 'permissions'], ['accountId', 'name', 'permissions']));
}));
app.delete('/gateway/app-passwords/:id', route(async (c, userId) => { query(c); return revokeCredential(c, userId, c.req.param('id')); }));
app.get('/gateway/submissions', route(async (c, userId) => {
	const { accountId } = query(c, ['accountId']);
	// Ownership and current domain/role constraints are not inferred from a JWT's
	// cached user object. The service also filters user/account at SQL level.
	const accounts = await webAccounts(c, userId);
	if (accountId !== undefined && !accounts.some(account => account.accountId === id(accountId))) fail(404, 'NOT_FOUND', 'Resource not found');
	const values = await submissionService.listForWeb(c, userId, accountId);
	const owned = new Set(accounts.map(account => account.accountId));
	return values.filter(value => owned.has(String(value.accountId))).slice(0, 50);
}));
