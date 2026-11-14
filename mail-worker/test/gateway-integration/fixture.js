import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import app from '../../src/api/gateway-api.js';
import { createCredential, revokeCredential } from '../../src/gateway/auth.js';
import { createSyntheticEnvironment } from '../gateway-core/sqlite-adapter.js';

// Existing attachment KV adapter only: deliberately no R2 binding or MIME store.
export async function createRelayEnvironment() {
	const env = await createSyntheticEnvironment();
	delete env.r2;
	const objects = new Map([['setting:', { value: JSON.stringify({ emailPrefixFilter: '' }) }]]);
	env.kv = {
		async get(key, options) {
			const value = objects.get(key)?.value ?? null;
			return options?.type === 'json' && value ? JSON.parse(value) : value;
		},
		async put(key, value, options = {}) {
			if (key !== 'setting:' && !key.startsWith('attachments/')) throw new Error('Unexpected non-attachment persistence');
			objects.set(key, { value, metadata: options.metadata });
		},
		async getWithMetadata(key) { const object = objects.get(key); return { value: object?.value ?? null, metadata: object?.metadata }; },
		async delete(key) { objects.delete(key); }
	};
	env.integrationObjects = objects;
	return env;
}

export async function startFixture({ mode = 'accepted', runCron } = {}) {
	if (mode === 'pause-commit' && typeof runCron !== 'function') throw new Error('Pending isolation requires the real legacy cron');
	const env = await createRelayEnvironment();
	// Seed historical structured mail, not a new APPEND or a stored raw MIME.
	env.db.sqlite.prepare(`INSERT INTO email(account_id,user_id,type,status,unread,send_email,to_email,subject,text,content,message_id,create_time)
	 VALUES(1,1,0,0,0,'alice@example.test','bob@destination.test','Synthetic legacy','Synthetic UTF-8 雪\n.dot-stuffing\n..two-dots\n','<p>Synthetic HTML 雪</p>','<synthetic-legacy@example.test>','2026-11-10 12:00:00')`).run();
	env.db.sqlite.prepare(`INSERT INTO attachments(email_id,account_id,user_id,key,filename,mime_type,size,type) VALUES(1,1,1,'attachments/legacy.bin','synthetic.bin','application/octet-stream',6,0)`).run();
	await env.kv.put('attachments/legacy.bin', Uint8Array.from([0,1,2,3,255,254]));
	env.integration = { mode, calls: [], pendingChecks: [] };
	const reachedPending = Promise.withResolvers();
	const releaseCommit = Promise.withResolvers();
	if (mode === 'pause-commit') {
		env.integration.beforeSentCommit = async (context, emailId) => {
			const status = () => env.db.sqlite.prepare('SELECT status FROM email WHERE email_id=?').get(emailId).status;
			const before = status();
			// Actual completeReceiveAll, after real attachment/ledger persistence but
			// before the real guarded finalization. IMAP probes this interval.
			await runCron(context);
			env.integration.pendingChecks.push({ before, after: status() });
			reachedPending.resolve();
			await releaseCommit.promise;
		};
	}
	const c = { env };
	const full = ['mail.read', 'mail.write', 'mail.send'];
	const alice = await createCredential(c, '1', { accountId: '1', name: 'Synthetic Alice', permissions: full });
	const bob = await createCredential(c, '2', { accountId: '2', name: 'Synthetic Bob', permissions: full });
	const readOnly = await createCredential(c, '1', { accountId: '1', name: 'Synthetic Read Only', permissions: ['mail.read'] });
	const revocable = await createCredential(c, '1', { accountId: '1', name: 'Synthetic Revocable', permissions: full });
	const control = randomBytes(24).toString('hex');
	const pending = new Set();
	const requests = new Set();
	let adapterFailures = 0;
	const server = createServer(async (incoming, outgoing) => {
		const completed = Promise.withResolvers();
		requests.add(completed.promise);
		try {
			const pathname = new URL(incoming.url, 'http://127.0.0.1').pathname;
			if (pathname.startsWith('/__fixture/')) {
				if (incoming.headers['x-fixture-control'] !== control) { outgoing.writeHead(403).end(); return; }
				if (pathname === '/__fixture/revoke' && incoming.method === 'POST') {
					await revokeCredential(c, '1', revocable.id);
					outgoing.writeHead(204).end(); return;
				}
				if (mode === 'pause-commit' && pathname === '/__fixture/await-pending' && incoming.method === 'GET') {
					await reachedPending.promise;
					outgoing.writeHead(204).end(); return;
				}
				if (mode === 'pause-commit' && pathname === '/__fixture/release-commit' && incoming.method === 'POST') {
					releaseCommit.resolve();
					outgoing.writeHead(204).end(); return;
				}
				if (pathname === '/__fixture/state' && incoming.method === 'GET') {
					const submissions = env.db.sqlite.prepare('SELECT state,phase FROM gateway_submissions ORDER BY created_at,id').all();
					outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ calls: env.integration.calls.length, submissions })); return;
				}
				outgoing.writeHead(404).end(); return;
			}
			const chunks = [];
			let length = 0;
			for await (const chunk of incoming) {
				length += chunk.length;
				if (length > 26 * 1024 * 1024) { outgoing.writeHead(413).end(); return; }
				chunks.push(chunk);
			}
			const headers = new Headers();
			for (const [key, value] of Object.entries(incoming.headers)) {
				if (value !== undefined && !['host', 'connection', 'transfer-encoding'].includes(key)) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
			}
			// A local HTTP adapter only: the Go client reaches this via a verified
			// httptest TLS reverse proxy. No fake /api/gateway responses or principal.
			const request = new Request(`http://127.0.0.1${incoming.url}`, {
				method: incoming.method, headers,
				...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {})
			});
			const executionCtx = { waitUntil(task) { pending.add(task); task.finally(() => pending.delete(task)); }, passThroughOnException() {} };
			const response = await app.fetch(request, env, executionCtx);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
			outgoing.end();
		} catch {
			// Exception text can contain MIME, tokens or SQL parameters.
			adapterFailures++;
			if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
			outgoing.end('{"error":{"code":"FIXTURE_ADAPTER_FAILURE"}}');
		} finally {
			completed.resolve();
			requests.delete(completed.promise);
		}
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const url = `http://127.0.0.1:${server.address().port}`;
	return {
		env, adapterFailures: () => adapterFailures,
		childEnv: {
			CMG_INTEGRATION_FIXTURE: url, CMG_INTEGRATION_CONTROL: control,
			CMG_INTEGRATION_ALICE: alice.password, CMG_INTEGRATION_BOB: bob.password,
			CMG_INTEGRATION_READ_ONLY: readOnly.password, CMG_INTEGRATION_REVOCABLE: revocable.password
		},
		async close() {
			reachedPending.resolve();
			releaseCommit.resolve();
			server.closeAllConnections();
			await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			await Promise.allSettled([...requests]);
			await Promise.allSettled([...pending]);
			env.db.close();
		}
	};
}
