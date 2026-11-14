import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticEnvironment } from './sqlite-adapter.js';
import { createCredential, listCredentials, createSession, requireGatewayAuth, mutationGuard, revokeCredential, webAccounts, logout } from '../../src/gateway/auth.js';
import { safeGatewayError } from '../../src/gateway/errors.js';
import { readJSON, sha256 } from '../../src/gateway/validation.js';

const environments = [];
afterEach(() => { for (const env of environments.splice(0)) env.db.close(); });
const context = (env, token, options = {}) => {
	const request = new Request('https://worker.example.test/api/gateway/v1', { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
	return { env, req: { raw: request, header: name => request.headers.get(name) ?? undefined } };
};
async function setup(permissions = ['mail.read', 'mail.write', 'mail.send']) {
	const env = await createSyntheticEnvironment(); environments.push(env);
	const c = context(env);
	const credential = await createCredential(c, 1, { accountId: 1, name: 'Offline auth', permissions });
	const session = await createSession(c, { mailbox_address: 'ALICE@EXAMPLE.TEST', app_password: credential.password });
	const authenticated = context(env, session.session_token);
	const principal = await requireGatewayAuth(authenticated, permissions[0]);
	return { env, c: authenticated, credential, session, principal };
}
async function guardedWrite(f) {
	const guard = mutationGuard(f.c, f.principal);
	try { return await f.env.db.batch([guard.start, f.env.db.prepare("UPDATE account SET name='UNAUTHORIZED' WHERE account_id=1"), guard.end]); }
	catch (error) { throw safeGatewayError(error); }
}

describe('application passwords, sessions and live authorization', () => {
	it('returns a high-entropy password once, persists only hashes, and never exposes it in lists', async () => {
		const f = await setup();
		expect(f.credential.password).toMatch(/^cmg_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
		expect(f.session.session_token).toMatch(/^cmgs_[A-Za-z0-9_-]{43}$/);
		const credential = f.env.db.sqlite.prepare('SELECT * FROM gateway_credentials').get();
		const session = f.env.db.sqlite.prepare('SELECT * FROM gateway_sessions').get();
		expect(credential.password_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(session.token_hash).toBe(await sha256(f.session.session_token));
		expect(JSON.stringify(credential)).not.toContain(f.credential.password.split('.')[1]);
		expect(JSON.stringify(session)).not.toContain(f.session.session_token);
		const listed = await listCredentials(f.c, 1);
		expect(listed).toHaveLength(1);
		expect(Object.keys(listed[0]).sort()).toEqual(['accountId','createdAt','id','lastUsedAt','mailboxAddress','name','permissions','revokedAt'].sort());
		expect(JSON.stringify(listed)).not.toMatch(/password|token_hash|secret/);
		expect(await listCredentials(f.c, 2)).toEqual([]);
	});
	it('binds app-password login to its owned mailbox and rejects another user/mailbox without a secret leak', async () => {
		const f = await setup();
		await expect(createSession(f.c, { mailbox_address: 'bob@example.test', app_password: f.credential.password })).rejects.toMatchObject({ status: 401 });
		await expect(createCredential(f.c, 2, { accountId: 1, name: 'Cross-user', permissions: ['mail.read'] })).rejects.toMatchObject({ status: 404 });
		await expect(revokeCredential(f.c, 2, f.credential.id)).rejects.toMatchObject({ status: 404 });
		await expect(requireGatewayAuth(context(f.env, f.credential.password))).rejects.toMatchObject({ status: 401 });
		await expect(requireGatewayAuth(context(f.env, 'legacy-web-jwt'))).rejects.toMatchObject({ status: 401 });
	});
	it('revokes all sessions immediately and logout revokes just the current session', async () => {
		const f = await setup();
		const second = await createSession(f.c, { mailbox_address: 'alice@example.test', app_password: f.credential.password });
		await logout(f.c, f.principal);
		await expect(requireGatewayAuth(f.c)).rejects.toMatchObject({ status: 401 });
		await expect(requireGatewayAuth(context(f.env, second.session_token))).resolves.toMatchObject({ accountId: '1' });
		await revokeCredential(f.c, 1, f.credential.id);
		await expect(requireGatewayAuth(context(f.env, second.session_token))).rejects.toMatchObject({ status: 401 });
		await expect(createSession(f.c, { mailbox_address: 'alice@example.test', app_password: f.credential.password })).rejects.toMatchObject({ status: 401 });
	});
	it.each([
		['user disabled', 'UPDATE user SET status=1 WHERE user_id=1'],
		['user deleted', 'UPDATE user SET is_del=1 WHERE user_id=1'],
		['account disabled', 'UPDATE account SET status=1 WHERE account_id=1'],
		['account deleted', 'UPDATE account SET is_del=1 WHERE account_id=1'],
		['ownership changed', 'UPDATE account SET user_id=2 WHERE account_id=1'],
		['role lost', 'DELETE FROM role WHERE role_id=1'],
		['query permission removed', 'DELETE FROM role_perm WHERE role_id=1 AND perm_id=1', 403],
		['role domain removed', "UPDATE role SET avail_domain='other.test' WHERE role_id=1"],
		['credential revoked', 'UPDATE gateway_credentials SET revoked_at=1'],
		['session expired', 'UPDATE gateway_sessions SET expires_at=1']
	])('revalidates %s on requests and inside a previously authorized transaction', async (_description, sql, status = 401) => {
		const f = await setup();
		f.env.db.sqlite.exec(sql);
		await expect(requireGatewayAuth(f.c)).rejects.toMatchObject({ status });
		await expect(guardedWrite(f)).rejects.toMatchObject({ status: 401, code: 'SESSION_INVALID' });
		expect(f.env.db.sqlite.prepare('SELECT name FROM account WHERE account_id=1').get().name).toBe('Alice');
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_write_guard').get().n).toBe(0);
	});
	it('revalidates deployment-domain and exact mailbox-address changes inside mutation guards', async () => {
		const f = await setup();
		f.env.domain = ['other.test'];
		await expect(requireGatewayAuth(f.c)).rejects.toMatchObject({ status: 401 });
		await expect(guardedWrite(f)).rejects.toMatchObject({ status: 401 });
		f.env.domain = ['example.test'];
		f.env.db.sqlite.exec("UPDATE account SET email='renamed@example.test' WHERE account_id=1");
		await expect(guardedWrite(f)).rejects.toMatchObject({ status: 401 });
	});
	it('keeps whitespace-only domain policy equivalent in JavaScript and the SQL transaction guard', async () => {
		const f = await setup();
		f.env.db.sqlite.exec("UPDATE role SET avail_domain='     ' WHERE role_id=1");
		const principal = await requireGatewayAuth(f.c);
		expect(principal.accountId).toBe('1');
		await expect(guardedWrite(f)).resolves.toBeDefined();
		await expect(createCredential(f.c, 1, { accountId: 1, name: 'Blank domain policy', permissions: ['mail.read'] })).resolves.toHaveProperty('password');
	});
	it('continues to list and revoke owned credentials after mailbox-query permission is removed', async () => {
		const f = await setup();
		f.env.db.sqlite.exec('DELETE FROM role_perm WHERE role_id=1 AND perm_id=1');
		await expect(webAccounts(f.c, 1)).rejects.toMatchObject({ status: 403 });
		await expect(listCredentials(f.c, 1)).resolves.toHaveLength(1);
		await expect(createCredential(f.c, 1, { accountId: 1, name: 'Denied', permissions: ['mail.read'] })).rejects.toMatchObject({ status: 403 });
		await expect(revokeCredential(f.c, 1, f.credential.id)).resolves.toEqual({ revoked: true });
	});
	it('never upgrades a read-only credential into write/send and checks the current send permission', async () => {
		const f = await setup(['mail.read']);
		await expect(requireGatewayAuth(f.c, 'mail.write')).rejects.toMatchObject({ status: 403 });
		await expect(requireGatewayAuth(f.c, 'mail.send')).rejects.toMatchObject({ status: 403 });
		const sender = await createCredential(f.c, 1, { accountId: 1, name: 'Sender', permissions: ['mail.send'] });
		const session = await createSession(f.c, { mailbox_address: 'alice@example.test', app_password: sender.password });
		const c = context(f.env, session.session_token);
		await expect(requireGatewayAuth(c, 'mail.send')).resolves.toMatchObject({ permissions: ['mail.send'] });
		f.env.db.sqlite.exec('DELETE FROM role_perm WHERE role_id=1 AND perm_id=2');
		await expect(requireGatewayAuth(c, 'mail.send')).rejects.toMatchObject({ status: 403 });
	});
	it('bounds credential count and permits replacement after explicit revocation', async () => {
		const f = await setup(['mail.read']);
		for (let i = 1; i < 20; i++) await createCredential(f.c, 1, { accountId: 1, name: `Offline ${i}`, permissions: ['mail.read'] });
		await expect(createCredential(f.c, 1, { accountId: 1, name: 'Over limit', permissions: ['mail.read'] })).rejects.toMatchObject({ status: 409, code: 'CREDENTIAL_LIMIT' });
		await revokeCredential(f.c, 1, f.credential.id);
		await expect(createCredential(f.c, 1, { accountId: 1, name: 'Replacement', permissions: ['mail.read'] })).resolves.toHaveProperty('password');
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_credentials WHERE revoked_at IS NULL').get().n).toBe(20);
	});
	it('enforces account login-rate limits without persisting plaintext guesses', async () => {
		const f = await setup();
		for (let i = 1; i < 15; i++) await expect(createSession(f.c, { mailbox_address: 'alice@example.test', app_password: 'synthetic-wrong-password' })).rejects.toMatchObject({ status: 401 });
		await expect(createSession(f.c, { mailbox_address: 'alice@example.test', app_password: f.credential.password })).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
		expect(JSON.stringify(f.env.db.sqlite.prepare('SELECT * FROM gateway_rate_limits').all())).not.toMatch(/alice|password|unknown/);
	});
	it('rejects the scopes alias and unknown fields in strict management JSON', async () => {
		const f = await setup();
		const parse = value => readJSON(context(f.env, undefined, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }), ['accountId', 'name', 'permissions'], ['accountId','name','permissions']);
		await expect(parse({ accountId: '1', name: 'Alias', scopes: ['mail.read'] })).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
		await expect(parse({ accountId: '1', name: 'Extra', permissions: ['mail.read'], userId: 2 })).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
		await expect(parse({ accountId: '1', name: 'Valid', permissions: ['mail.read'] })).resolves.toMatchObject({ permissions: ['mail.read'] });
	});
});
