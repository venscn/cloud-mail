import { afterEach, describe, expect, it, vi } from 'vitest';

// Dormant external transport entry points fail closed. Routing, JWT/KV web
// authentication, gateway credentials, SQLite and every handler are real.
vi.mock('worker-mailer', () => ({
	WorkerMailer: class { constructor() { throw new Error('External SMTP is forbidden in routing tests'); } },
	encodeHeader() { throw new Error('External SMTP serialization is outside this fixture'); }
}));

import worker from '../../src/index.js';
import jwtUtils from '../../src/utils/jwt-utils.js';
import constant from '../../src/const/constant.js';
import { createCredential } from '../../src/gateway/auth.js';
import { createRelayEnvironment } from './fixture.js';

const environments = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const env of environments.splice(0)) env.db.close();
});

async function setup() {
	const env = await createRelayEnvironment();
	environments.push(env);
	env.jwt_secret = 'synthetic-jwt-signing-key-never-for-production';
	const webSessions = new Map();
	env.kv = {
		async get(key, options) {
			const value = webSessions.get(key);
			return options?.type === 'json' && value ? JSON.parse(value) : value ?? null;
		},
		async put(key, value) { webSessions.set(key, value); }
	};
	webSessions.set('auth-uid:1', JSON.stringify({
		tokens: ['synthetic-web-login'], refreshTime: new Date().toISOString(),
		user: { userId: 1, email: 'alice@example.test' }
	}));
	const webJWT = await jwtUtils.generateToken({ env }, {
		userId: 1, token: 'synthetic-web-login', gen: constant.AUTH_GEN
	}, 3600);
	const credential = await createCredential({ env }, 1, {
		accountId: '1', name: 'Synthetic routing credential', permissions: ['mail.read', 'mail.write', 'mail.send']
	});
	const call = (path, { authorization, json, headers, ...options } = {}) => worker.fetch(new Request(`https://worker.example.test${path}`, {
		...options,
		headers: { ...(authorization ? { Authorization: authorization } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
		...(json !== undefined ? { body: JSON.stringify(json) } : {})
	}), env, { waitUntil() {}, passThroughOnException() {} });
	const login = await call('/api/gateway/v1/sessions', {
		method: 'POST', json: { mailbox_address: 'alice@example.test', app_password: credential.password }
	});
	expect(login.status).toBe(200);
	const session = (await login.json()).data;
	return { env, webSessions, webJWT, credential, session, call };
}

async function errorBody(response, status, protocol = true) {
	expect(response.status).toBe(status);
	expect(response.headers.get('Cache-Control')).toBe('no-store');
	const value = await response.json();
	if (protocol) {
		expect(value.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
		expect(typeof value.error.retryable).toBe('boolean');
		expect(value.error.request_id).toMatch(/^[a-f0-9-]{36}$/);
		expect(value).not.toHaveProperty('data');
	} else {
		expect(value.code).toBe(status);
		expect(value).not.toHaveProperty('data');
	}
	return value;
}

describe('actual Worker dispatch and HTTP authorization boundaries', () => {
	it('serves public protocol capabilities without a web JWT or any KV access', async () => {
		const f = await setup();
		f.env.kv = { get() { throw new Error('Protocol dispatch must not use web KV'); } };
		const response = await f.call('/api/gateway/v1/capabilities');
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(await response.json()).toMatchObject({ data: { version: 1, max_recipients: 50, page_size: 200 } });
	});

	it('explicitly refuses new APPEND and COPY with no R2 binding or stored MIME', async () => {
		const f = await setup();
		expect(f.env).not.toHaveProperty('r2');
		const authorization = `Bearer ${f.session.session_token}`;
		const listed = await (await f.call('/api/gateway/v1/mailboxes', { authorization })).json();
		const inbox = listed.data.mailboxes.find(mailbox => mailbox.name === 'INBOX');
		const append = await f.call(`/api/gateway/v1/mailboxes/${inbox.id}/messages`, {
			method: 'POST', authorization, headers: { 'Content-Type': 'message/rfc822', 'Idempotency-Key': 'synthetic-new-append' },
			body: 'From: alice@example.test\r\nTo: bob@example.test\r\n\r\nSynthetic only\r\n'
		});
		expect(await errorBody(append, 501)).toMatchObject({ error: { code: 'APPEND_UNSUPPORTED', retryable: false } });
		const copy = await f.call(`/api/gateway/v1/mailboxes/${inbox.id}/copy`, {
			method: 'POST', authorization, json: { uids: [1], destination_id: String(inbox.id) }
		});
		expect(await errorBody(copy, 501)).toMatchObject({ error: { code: 'COPY_UNSUPPORTED', retryable: false } });
		expect(f.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_raw').get().n).toBe(0);
	});

	it('rejects plaintext remote protocol requests before exposing capabilities', async () => {
		const f = await setup();
		const response = await worker.fetch(new Request('http://worker.example.test/api/gateway/v1/capabilities'), f.env, {});
		expect(await errorBody(response, 426)).toMatchObject({ error: { code: 'TLS_REQUIRED' } });
	});

	it('routes only the exact v1 namespace, not similarly prefixed management URLs', async () => {
		const f = await setup();
		expect(await errorBody(await f.call('/api/gateway/v1/not-a-route'), 404)).toMatchObject({ error: { code: 'NOT_FOUND' } });
		for (const path of ['/api/gateway/v10/capabilities', '/api/gateway/v1-suffix/capabilities']) {
			await errorBody(await f.call(path, { authorization: 'synthetic-not-a-jwt' }), 401, false);
		}
	});

	it('never accepts a web JWT or an application password as a protocol bearer session', async () => {
		const f = await setup();
		for (const authorization of [`Bearer ${f.webJWT}`, `Bearer ${f.credential.password}`]) {
			await errorBody(await f.call('/api/gateway/v1/mailboxes', { authorization }), 401);
		}
	});

	it('never accepts protocol sessions or application passwords as web authentication', async () => {
		const f = await setup();
		for (const authorization of [f.session.session_token, `Bearer ${f.session.session_token}`, f.credential.password]) {
			await errorBody(await f.call('/api/gateway/app-passwords', { authorization }), 401, false);
		}
	});

	it('uses the existing signed JWT plus live KV session for one-time password management', async () => {
		const f = await setup();
		const response = await f.call('/api/gateway/app-passwords', {
			method: 'POST', authorization: f.webJWT,
			json: { accountId: '1', name: 'Synthetic iOS', permissions: ['mail.read'] }
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		const created = (await response.json()).data;
		expect(created.password).toMatch(/^cmg_/);
		const listed = await f.call('/api/gateway/app-passwords', { authorization: f.webJWT });
		const body = await listed.json();
		expect(body.code).toBe(200);
		expect(body.data).toHaveLength(2);
		expect(JSON.stringify(body)).not.toContain(created.password);
		expect(JSON.stringify(body)).not.toMatch(/password_hash|token_hash|"password"/);
		const revoked = await f.call(`/api/gateway/app-passwords/${created.id}`, { method: 'DELETE', authorization: f.webJWT });
		expect(await revoked.json()).toMatchObject({ code: 200, data: { revoked: true } });
	});

	it('rejects a still-valid signed web JWT once its server-side KV session is gone', async () => {
		const f = await setup();
		f.webSessions.clear();
		await errorBody(await f.call('/api/gateway/app-passwords', { authorization: f.webJWT }), 401, false);
	});

	it('checks live mailbox ownership for credential creation, revocation and submission inspection', async () => {
		const f = await setup();
		const foreign = await createCredential({ env: f.env }, 2, { accountId: '2', name: 'Synthetic Bob', permissions: ['mail.read'] });
		await errorBody(await f.call('/api/gateway/app-passwords', {
			method: 'POST', authorization: f.webJWT,
			json: { accountId: '2', name: 'Forbidden', permissions: ['mail.read'] }
		}), 404, false);
		await errorBody(await f.call(`/api/gateway/app-passwords/${foreign.id}`, { method: 'DELETE', authorization: f.webJWT }), 404, false);
		await errorBody(await f.call('/api/gateway/submissions?accountId=2', { authorization: f.webJWT }), 404, false);
	});

	it('rejects unknown/duplicate query fields and unknown credential fields at the HTTP boundary', async () => {
		const f = await setup();
		await errorBody(await f.call('/api/gateway/v1/capabilities?extra=1'), 400);
		await errorBody(await f.call('/api/gateway/submissions?accountId=1&accountId=2', { authorization: f.webJWT }), 400, false);
		await errorBody(await f.call('/api/gateway/app-passwords', {
			method: 'POST', authorization: f.webJWT,
			json: { accountId: '1', name: 'Invalid', permissions: ['mail.read'], admin: true }
		}), 400, false);
	});

	it('returns sanitized real HTTP failures without SQL, exception text or authentication material', async () => {
		const f = await setup();
		f.env.db.prepare = () => { throw new Error(`synthetic-private-database-error ${f.credential.password}`); };
		const protocol = await errorBody(await f.call('/api/gateway/v1/mailboxes', { authorization: `Bearer ${f.session.session_token}` }), 503);
		const management = await errorBody(await f.call('/api/gateway/app-passwords', { authorization: f.webJWT }), 503, false);
		for (const value of [protocol, management]) {
			expect(JSON.stringify(value)).not.toContain('synthetic-private-database-error');
			expect(JSON.stringify(value)).not.toContain(f.credential.password);
		}
	});
});
