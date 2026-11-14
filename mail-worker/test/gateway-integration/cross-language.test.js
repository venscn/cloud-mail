import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only the outbound provider/save boundary is synthetic. In particular DO NOT
// mock gateway-api, auth, schema, store, raw helpers or submission repository.
vi.mock('../../src/service/email-service.js', async importOriginal => {
	const actual = await importOriginal();
	return { ...actual, default: { ...actual.default, send: (await import('./synthetic-send.js')).syntheticSend } };
});
// Loading the real legacy cron method must not load Cloudflare-only sockets.
// These SDK entry points are dormant: fail closed if any provider is invoked.
vi.mock('worker-mailer', () => ({
	WorkerMailer: class { constructor() { throw new Error('External SMTP is forbidden in integration tests'); } },
	encodeHeader() { throw new Error('External SMTP serialization is outside this fixture'); }
}));

import emailService from '../../src/service/email-service.js';
import { emailConst } from '../../src/const/entity-const.js';
import { startFixture } from './fixture.js';

const goDirectory = fileURLToPath(new URL('../../../../cloud-mail-gateway/', import.meta.url));
const fixtures = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function fixture(options) {
	const value = await startFixture(options);
	fixtures.push(value);
	return value;
}

async function runGo(testName, value) {
	await new Promise((resolve, reject) => {
		// inherit is intentional: no captured child pipes, no protocol tracing,
		// credentials only in environment, and no shell interpolation.
		const child = spawn(process.env.CMG_INTEGRATION_GO || 'go', [
			'test', '-count=1', '-v', '-timeout=75s', '-run', `^${testName}$`, './test/integration'
		], {
			cwd: goDirectory,
			stdio: 'inherit',
			env: { ...process.env, GOTOOLCHAIN: 'local', ...value.childEnv }
		});
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error(`${testName}: local Go test exceeded 120 seconds`));
		}, 120000);
		child.once('error', () => {
			clearTimeout(timeout);
			reject(new Error('Cannot launch Go; put Go 1.26+ on PATH or set CMG_INTEGRATION_GO to its executable'));
		});
		child.once('exit', (code, signal) => {
			clearTimeout(timeout);
			if (code === 0 && !signal) resolve();
			else reject(new Error(`${testName}: Go integration failed (exit=${code}, signal=${signal || 'none'})`));
		});
	});
	expect(value.adapterFailures(), 'Node HTTP adapter exceptions').toBe(0);
}

function submissions(value) {
	return value.env.db.sqlite.prepare('SELECT * FROM gateway_submissions ORDER BY created_at,id').all();
}

function expectDurableDispatch(value, count) {
	expect(value.env.integration.calls).toHaveLength(count);
	for (const call of value.env.integration.calls) {
		expect(call.stateAtDispatch).toBe('sending');
		expect(call.phaseAtDispatch).toBe('dispatching');
		// Header-only recipients never expand the explicit SMTP envelope.
		expect(call.recipients).not.toContain('header-only@destination.test');
		expect(call.payloadHash).toMatch(/^[a-f0-9]{64}$/);
	}
}

describe('real Go TLS protocols → actual Worker Hono API + auth + SQLite/R2', () => {
	it('validates TLS trust, real application passwords, scopes and mailbox bootstrap', async () => {
		const value = await fixture();
		await runGo('TestCloudTLSAndAuth', value);
		expect(value.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_sessions').get().n).toBeGreaterThan(0);
		expectDurableDispatch(value, 0);
	});

	it('preserves UID, flags and exact MIME across reconnect/server restart, COPY/MOVE and Sent APPEND', async () => {
		const value = await fixture();
		await runGo('TestCloudIMAPLifecycle', value);
		expectDurableDispatch(value, 0);
		expect(submissions(value)).toHaveLength(0);
	});

	it('enforces EXAMINE/read-only scope, account isolation and live-session credential revocation', async () => {
		const value = await fixture();
		await runGo('TestCloudAuthorization', value);
		expectDurableDispatch(value, 0);
		expect(value.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_credentials WHERE revoked_at IS NOT NULL').get().n).toBe(1);
	});

	it('binds STARTTLS/implicit-TLS SMTP sender/envelope to real durable idempotent submissions and Sent copies', async () => {
		const value = await fixture();
		await runGo('TestCloudSMTPSubmission', value);
		expectDurableDispatch(value, 2);
		for (const call of value.env.integration.calls) {
			expect([...call.recipients].sort()).toEqual(['bob@destination.test', 'hidden@destination.test']);
		}
		expect(submissions(value)).toHaveLength(2);
		for (const row of submissions(value)) {
			expect(row.state).toBe('sent');
			expect(row.phase).toBe('complete');
		}
		expect(value.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM email WHERE type=1 AND status=0').get().n).toBe(2);
		expect(value.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_sent_copies').get().n).toBe(2);
	});

	it('keeps staged Sent invisible through the real legacy cron and only exposes the guarded commit', async () => {
		const value = await fixture({ mode: 'pause-commit', runCron: context => emailService.completeReceiveAll(context) });
		await runGo('TestCloudSMTPPendingIsolation', value);
		expectDurableDispatch(value, 1);
		expect(value.env.integration.pendingChecks).toEqual([{
			before: emailConst.status.GATEWAY_PENDING, after: emailConst.status.GATEWAY_PENDING
		}]);
		const rows = submissions(value);
		expect(rows).toHaveLength(1);
		expect(rows[0].state).toBe('sent');
		expect(rows[0].phase).toBe('complete');
		expect(value.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM email WHERE status=?').get(emailConst.status.GATEWAY_PENDING).n).toBe(0);
	});

	it('retains durable ambiguous outcome and refuses blind resend on reconnect/retry', async () => {
		const value = await fixture({ mode: 'unknown' });
		await runGo('TestCloudSMTPUnknownOutcome', value);
		expectDurableDispatch(value, 1);
		const rows = submissions(value);
		expect(rows).toHaveLength(1);
		expect(rows[0].state).toBe('unknown');
		expect(rows[0].phase).toBe('reconcile_required');
		expect(value.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM email').get().n).toBe(0);
		expect(value.env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_sent_copies').get().n).toBe(0);
	});
});
