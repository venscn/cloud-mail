import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyntheticEnvironment } from './sqlite-adapter.js';

// Only integration boundaries are replaced: the real receive handler, postal-mime,
// Drizzle insert/completion and gateway D1/R2 code run against synthetic data.
vi.mock('../../src/service/smtp-send-service', () => ({ default: {} }));
vi.mock('../../src/service/setting-service', () => ({ default: { query: vi.fn() } }));
vi.mock('../../src/service/account-service', () => ({ default: { selectByEmailIncludeDel: vi.fn() } }));
vi.mock('../../src/service/user-service', () => ({ default: { selectByIdIncludeDel: vi.fn() } }));
vi.mock('../../src/service/role-service', () => ({ default: { selectByUserId: vi.fn().mockResolvedValue({ banEmail: '', availDomain: 'example.test' }), hasAvailDomainPerm: () => true, isBanEmail: () => false } }));
vi.mock('../../src/service/ai-service', () => ({ default: { extractCode: vi.fn().mockResolvedValue('') } }));
vi.mock('../../src/service/telegram-service', () => ({ default: {} }));
vi.mock('../../src/service/webhook-service', () => ({ default: {} }));
vi.mock('../../src/service/att-service', () => ({ default: { addAtt: vi.fn() } }));
import { email as receive } from '../../src/email/email.js';
import settingService from '../../src/service/setting-service';
import accountService from '../../src/service/account-service';
import userService from '../../src/service/user-service';
import roleService from '../../src/service/role-service';
import { safeGatewayError } from '../../src/gateway/errors.js';
import { applyGatewayMigration } from '../../src/gateway/schema.js';
import { ensureGatewaySchema } from '../../src/gateway/auth.js';
import { freezeLegacyEmail, readPrivateRaw } from '../../src/gateway/raw.js';

const encoder = new TextEncoder();
const mime = encoder.encode('From: Sender <sender@example.test>\r\nTo: alice@example.test\r\nSubject: UTF-8 receive\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n精确字节 café\r\n');
const environments = [];
beforeEach(() => {
	vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in synthetic receive tests'));
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	settingService.query.mockResolvedValue({ receive: 0, tgBotStatus: 1, forwardStatus: 1, webhookStatus: 1, noRecipient: 1, r2Domain: 'https://objects.example.test' });
	accountService.selectByEmailIncludeDel.mockResolvedValue({ accountId: 1, userId: 1, email: 'alice@example.test' });
	userService.selectByIdIncludeDel.mockResolvedValue({ userId: 1, email: 'alice@example.test' });
	roleService.selectByUserId.mockResolvedValue({ banEmail: '', availDomain: 'example.test' });
});
afterEach(() => { for (const env of environments.splice(0)) env.db.close(); vi.restoreAllMocks(); });
async function environment(options) { const env = await createSyntheticEnvironment(options); environments.push(env); return env; }
function message(bytes = mime, rawSize = bytes.byteLength) {
	// One byte per chunk deliberately splits UTF-8 code points and CRLF pairs.
	return { from: 'sender@example.test', to: 'alice@example.test', rawSize,
		raw: new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
		setReject: vi.fn(), forward: vi.fn().mockRejectedValue(new Error('Forward forbidden')) };
}
function received(env) { return env.db.sqlite.prepare('SELECT * FROM email ORDER BY email_id DESC LIMIT 1').get(); }

describe('ordinary receive compatibility through the actual handler', () => {
	it.each(['unmigrated', 'missing-r2', 'r2-put-failure'])('completes ordinary web mail when optional gateway capture is %s', async mode => {
		const env = await environment({ migrate: mode !== 'unmigrated' });
		if (mode === 'missing-r2') delete env.r2;
		if (mode === 'r2-put-failure') env.r2.put = vi.fn().mockRejectedValue(new Error('synthetic storage failure'));
		const incoming = message();
		await receive(incoming, env, {});
		expect(incoming.setReject).not.toHaveBeenCalled();
		const row = received(env);
		expect(row).toMatchObject({ account_id: 1, user_id: 1, is_del: 0, status: 0 });
		expect(row.text).toContain('精确字节 café');
		if (mode === 'unmigrated') await expect(ensureGatewaySchema({ env }).catch(error => { throw safeGatewayError(error); })).rejects.toMatchObject({ status: 503, code: 'GATEWAY_NOT_INITIALIZED' });
		else expect(env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_email_raw').get().n).toBe(0);
	});
	it('captures the original stream bytes before publishing the completed legacy row', async () => {
		const env = await environment();
		const put = env.r2.put.bind(env.r2);
		env.r2.put = vi.fn(async (...args) => {
			expect(received(env)).toMatchObject({ status: 6, is_del: 1 });
			expect(env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM gateway_messages').get().n).toBe(0);
			return put(...args);
		});
		await receive(message(), env, {});
		const raw = env.db.sqlite.prepare('SELECT r.* FROM gateway_raw r JOIN gateway_email_raw e ON e.raw_id=r.id').get();
		expect(raw.source).toBe('received');
		expect(raw.size).toBe(mime.byteLength);
		expect(await readPrivateRaw({ env }, raw)).toEqual(mime);
		expect(received(env)).toMatchObject({ status: 0, is_del: 0 });
	});
	it('labels later migration recovery as reconstructed, never original received MIME', async () => {
		const env = await environment({ migrate: false });
		await receive(message(), env, {});
		await applyGatewayMigration({ env });
		await freezeLegacyEmail({ env }, received(env).email_id, 1);
		expect(env.db.sqlite.prepare('SELECT source FROM gateway_raw').get().source).toBe('reconstructed');
	});
	it('rejects declared oversize before parsing or persisting any message', async () => {
		const env = await environment({ migrate: false });
		const incoming = message(mime, 26214401);
		await receive(incoming, env, {});
		expect(incoming.setReject).toHaveBeenCalledWith('Message exceeds the 25 MiB size limit');
		expect(received(env)).toBeUndefined();
	});
});
