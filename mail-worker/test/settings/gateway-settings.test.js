import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { createSQLiteD1 } from '../gateway-core/sqlite-adapter.js';
import setting from '../../src/entity/setting.js';
import { GATEWAY_SETTINGS_COLUMNS, applyGatewaySettingsMigration } from '../../src/init/gateway-settings-migration.js';
import { normalizeGatewayHostname, gatewayDisplayConfig } from '../../src/utils/gateway-settings.js';

vi.mock('../../src/service/r2-service', () => ({ default: { storageType: async () => 'kv' } }));
vi.mock('../../src/service/smtp-send-service', () => ({ default: { normalizeEnvelopeFrom: value => value } }));
vi.mock('../../src/service/verify-record-service', () => ({ default: { selectListByIP: async () => [] } }));
vi.mock('../../src/service/user-service', () => ({ default: { updateUserInfo: async () => {} } }));
vi.mock('../../src/service/perm-service', () => ({ default: { userPermKeys: async () => [] } }));
vi.mock('../../src/utils/jwt-utils', () => ({ default: { verifyToken: async (_c, token) => token ? { userId: token, token, gen: 'fixture-gen' } : null } }));
vi.mock('../../src/security/user-context', () => ({ default: { getToken: async () => null } }));
vi.mock('../../src/i18n/i18n', () => ({ t: key => key }));

import settingService from '../../src/service/setting-service.js';
import { dbInit } from '../../src/init/init.js';
import constant from '../../src/const/constant.js';
import KvConst from '../../src/const/kv-const.js';
import app from '../../src/hono/hono.js';
import '../../src/security/security.js';
import '../../src/api/setting-api.js';

const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function fixture() {
	const db = createSQLiteD1(); databases.push(db);
	const columns = getTableConfig(setting).columns.map(column => `${column.name} ${column.dataType === 'number' ? 'INTEGER' : 'TEXT'}${column.notNull ? ' NOT NULL' : ''}${column.default !== undefined ? ` DEFAULT ${quote(column.default)}` : ''}`);
	db.sqlite.exec(`CREATE TABLE setting (${columns.join(',')}); INSERT INTO setting DEFAULT VALUES;`);
	// Synthetic markers only; never reads any account/mail/credential table.
	db.sqlite.exec("UPDATE setting SET title='Synthetic site', secret_key='synthetic-turnstile-secret', smtp_channels='{}', resend_tokens='{}', webhook_secret='synthetic-webhook-secret', github_client_secret='synthetic-oauth-secret', s3_secret_key='synthetic-storage-secret'");
	const values = new Map();
	const env = {
		db, domain: ['example.test'], admin: 'admin@example.test',
		kv: {
			async get(key, options) { const value = values.get(key); return options?.type === 'json' && value ? JSON.parse(value) : value ?? null; },
			async put(key, value) { values.set(key, value); }
		}
	};
	const state = new Map();
	const c = { env, get: key => state.get(key), set: (key, value) => state.set(key, value) };
	return { c, db, values, state, env };
}

describe('gateway hostname validation and fail-closed display', () => {
	it.each([' Mail.Example.TEST ', 'xn--bcher-kva.example', 'a-b.example', 'a'.repeat(63) + '.test'])( 'normalizes valid ASCII DNS hostname %s', value => {
		expect(normalizeGatewayHostname(value)).toBe(value.trim().toLowerCase());
	});
	it.each(['https://mail.example.test', 'mail.example.test/path', 'mail.example.test:993', 'user@mail.example.test', 'mail.example.test?x=1', 'mail.example.test#x', 'mail.example.test\\x', 'mail.example.test\r\nX: injected', '\tmail.example.test', 'mail.example.test\0', '<script>.example', "mail.example.test'; DROP TABLE setting;--", 'mail..test', '.example.test', 'mail.example.test.', '-mail.example.test', 'mail-.example.test', 'm_ail.example.test', 'máil.example.test', 'localhost', '127.0.0.1', '[::1]', 'a'.repeat(64) + '.test', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`, null, 123])('rejects invalid hostname %#', value => {
		expect(() => normalizeGatewayHostname(value)).toThrow();
	});
	it('keeps defaults and partial/invalid/stale snapshots disabled', () => {
		for (const value of [{}, { gatewayEnabled: 1 }, { gatewayHostname: 'mail.example.test' }, { gatewayEnabled: '1', gatewayHostname: 'mail.example.test' }, { gatewayEnabled: 1, gatewayHostname: 'https://bad.example.test' }]) {
			expect(gatewayDisplayConfig(value).gatewayEnabled).toBe(0);
		}
		expect(gatewayDisplayConfig({ gatewayEnabled: 1, gatewayHostname: ' MAIL.EXAMPLE.TEST ' })).toEqual({ gatewayEnabled: 1, gatewayHostname: 'mail.example.test' });
	});
});

describe('real setting service with synthetic SQLite and KV', () => {
	it('persists normalized fields, refreshes existing KV and preserves unrelated settings', async () => {
		const { c, db, values, state } = fixture();
		await settingService.refresh(c);
		await settingService.set(c, { gatewayEnabled: 1, gatewayHostname: ' MAIL.Example.TEST ' });
		expect(db.sqlite.prepare('SELECT gateway_enabled,gateway_hostname,title,secret_key FROM setting').get()).toMatchObject({ gateway_enabled: 1, gateway_hostname: 'mail.example.test', title: 'Synthetic site', secret_key: 'synthetic-turnstile-secret' });
		expect(JSON.parse(values.get(KvConst.SETTING))).toMatchObject({ gatewayEnabled: 1, gatewayHostname: 'mail.example.test' });
		state.clear();
		expect(await settingService.query(c)).toMatchObject({ gatewayEnabled: 1, gatewayHostname: 'mail.example.test' });
		await settingService.set(c, { gatewayEnabled: 0 });
		expect(await settingService.get(c)).toMatchObject({ gatewayEnabled: 0, gatewayHostname: 'mail.example.test' });
	});
	it('validates partial updates atomically and ignores no unrelated fields', async () => {
		const { c, db } = fixture(); await settingService.refresh(c);
		for (const patch of [{ gatewayEnabled: 1 }, { gatewayEnabled: '1' }, { gatewayEnabled: true }, { gatewayEnabled: null }, { gatewayEnabled: 2 }, { gatewayHostname: 'https://bad.example.test' }]) {
			await expect(settingService.set(c, { ...patch, title: 'must not write' })).rejects.toThrow();
			expect(db.sqlite.prepare('SELECT title,gateway_enabled FROM setting').get()).toMatchObject({ title: 'Synthetic site', gateway_enabled: 0 });
		}
		await settingService.set(c, { gatewayHostname: 'mail.example.test' });
		await settingService.set(c, { gatewayEnabled: 1 });
		await expect(settingService.set(c, { gatewayHostname: '' })).rejects.toThrow();
		await settingService.set(c, { gatewayEnabled: 0, gatewayHostname: '' });
		await settingService.set(c, { title: 'Updated site' });
		expect(db.sqlite.prepare('SELECT title,gateway_enabled,gateway_hostname FROM setting').get()).toMatchObject({ title: 'Updated site', gateway_enabled: 0, gateway_hostname: '' });
	});
	it('public websiteConfig explicitly exposes only safe fields and handles legacy KV', async () => {
		const { c, values, state } = fixture(); await settingService.refresh(c);
		const old = JSON.parse(values.get(KvConst.SETTING));
		delete old.gatewayEnabled; delete old.gatewayHostname;
		values.set(KvConst.SETTING, JSON.stringify(old)); state.clear();
		const result = await settingService.websiteConfig(c);
		expect(result).toMatchObject({ gatewayEnabled: 0, gatewayHostname: '', title: 'Synthetic site' });
		const forbidden = ['secretKey', 'smtpChannels', 'resendTokens', 's3SecretKey', 's3AccessKey', 'tgBotToken', 'webhookSecret', 'githubClientSecret', 'googleClientSecret', 'linuxdoClientSecret'];
		for (const key of forbidden) expect(result).not.toHaveProperty(key);
		expect(JSON.stringify(result)).not.toContain('synthetic-');
		await settingService.set(c, { gatewayEnabled: 1, gatewayHostname: 'mail.example.test' });
		expect(await settingService.websiteConfig(c)).toMatchObject({ gatewayEnabled: 1, gatewayHostname: 'mail.example.test' });
	});
	it('normalizes request-local stale cached settings too', async () => {
		const { c, state } = fixture();
		state.set('setting', { gatewayEnabled: 1, gatewayHostname: 'bad:993' });
		expect(await settingService.query(c)).toEqual({ gatewayEnabled: 0, gatewayHostname: '' });
	});
	it('keeps existing real security middleware boundaries for public, ordinary and admin callers', async () => {
		const { c, env, values } = fixture(); await settingService.refresh(c);
		const publicResponse = await app.request('/setting/websiteConfig', {}, env);
		expect((await publicResponse.json()).data).toMatchObject({ gatewayEnabled: 0, gatewayHostname: '' });
		const makeAuth = email => ({ tokens: [email], user: { userId: email, email }, refreshTime: new Date().toISOString() });
		for (const email of ['ordinary@example.test', env.admin]) values.set(KvConst.AUTH_INFO + email, JSON.stringify(makeAuth(email)));
		// Match the production generation constant without ever minting or using a real token.
		const jwt = (await import('../../src/utils/jwt-utils.js')).default;
		jwt.verifyToken = async (_c, token) => token ? { userId: token, token, gen: constant.AUTH_GEN } : null;
		for (const path of ['/setting/query', '/setting/set']) {
			const options = path.endsWith('/set') ? { method: 'PUT', body: JSON.stringify({ gatewayEnabled: 1, gatewayHostname: 'mail.example.test' }), headers: { 'Content-Type': 'application/json' } } : {};
			const ordinary = await app.request(path, { ...options, headers: { ...options.headers, [constant.TOKEN_HEADER]: 'ordinary@example.test' } }, env);
			expect((await ordinary.json()).code).toBe(403);
			const admin = await app.request(path, { ...options, headers: { ...options.headers, [constant.TOKEN_HEADER]: env.admin } }, env);
			expect((await admin.json()).code).toBe(200);
		}
		expect(JSON.parse(values.get(KvConst.SETTING))).toMatchObject({ gatewayEnabled: 1, gatewayHostname: 'mail.example.test' });
	});
});

describe('new additive gateway settings migration', () => {
	it('fresh initializer schema has defaults and is compatible with repeated guarded upgrade', async () => {
		const db = createSQLiteD1(); databases.push(db);
		await dbInit.intDB({ env: { db } });
		await applyGatewaySettingsMigration({ env: { db } });
		await applyGatewaySettingsMigration({ env: { db } });
		expect(db.sqlite.prepare('SELECT gateway_enabled,gateway_hostname FROM setting').get()).toMatchObject({ gateway_enabled: 0, gateway_hostname: '' });
	});
	it('matches SQL to guarded canonical columns, preserves existing data and resumes partial application', async () => {
		const sql = readFileSync(new URL('../../migrations/0002_gateway_settings.sql', import.meta.url), 'utf8');
		expect(sql.split('\n').filter(line => !line.startsWith('--')).join('\n').trim()).toBe(GATEWAY_SETTINGS_COLUMNS.map(column => column.sql).join('\n'));
		const db = createSQLiteD1(); databases.push(db);
		db.sqlite.exec("CREATE TABLE setting(title TEXT, secret_key TEXT); INSERT INTO setting VALUES('Synthetic title','synthetic-marker'); CREATE TABLE existing_metadata(id INTEGER); INSERT INTO existing_metadata VALUES(42);");
		db.sqlite.exec(GATEWAY_SETTINGS_COLUMNS[0].sql);
		await applyGatewaySettingsMigration({ env: { db } });
		db.sqlite.exec("UPDATE setting SET gateway_enabled=1,gateway_hostname='mail.example.test'");
		await applyGatewaySettingsMigration({ env: { db } });
		expect(db.sqlite.prepare('SELECT * FROM setting').get()).toMatchObject({ title: 'Synthetic title', secret_key: 'synthetic-marker', gateway_enabled: 1, gateway_hostname: 'mail.example.test' });
		expect(db.sqlite.prepare('SELECT id FROM existing_metadata').get().id).toBe(42);
	});
	it('defaults disabled on existing rows, accepts standalone SQL once and rejects invalid switch values', () => {
		const db = createSQLiteD1(); databases.push(db);
		db.sqlite.exec("CREATE TABLE setting(title TEXT); INSERT INTO setting VALUES('Synthetic');");
		db.sqlite.exec(readFileSync(new URL('../../migrations/0002_gateway_settings.sql', import.meta.url), 'utf8'));
		expect(db.sqlite.prepare('SELECT gateway_enabled,gateway_hostname FROM setting').get()).toMatchObject({ gateway_enabled: 0, gateway_hostname: '' });
		expect(() => db.sqlite.exec('UPDATE setting SET gateway_enabled=2')).toThrow();
	});
	it('fails loudly for missing legacy tables and does not hide D1 failures', async () => {
		const db = createSQLiteD1(); databases.push(db);
		await expect(applyGatewaySettingsMigration({ env: { db } })).rejects.toThrow('Legacy setting table');
		await expect(applyGatewaySettingsMigration({ env: { db: { prepare: () => ({ all: async () => { throw new Error('Synthetic DB failure'); } }) } } })).rejects.toThrow('Synthetic DB failure');
	});
});
