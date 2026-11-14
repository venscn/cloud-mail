import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { createSQLiteD1 } from '../gateway-core/sqlite-adapter.js';
import setting from '../../src/entity/setting.js';
import { GATEWAY_SETTINGS_COLUMNS, applyGatewaySettingsMigration } from '../../src/init/gateway-settings-migration.js';
import { GATEWAY_SPLIT_HOSTS_COLUMNS, applyGatewaySplitHostsMigration } from '../../src/init/gateway-split-hosts-migration.js';
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
	const env = { db, domain: ['example.test'], admin: 'admin@example.test', kv: {
		async get(key, options) { const value = values.get(key); return options?.type === 'json' && value ? JSON.parse(value) : value ?? null; },
		async put(key, value) { values.set(key, value); }
	} };
	const state = new Map();
	const c = { env, get: key => state.get(key), set: (key, value) => state.set(key, value) };
	return { c, db, values, state, env };
}
const hosts = { gatewayImapHostname: 'imap.example.test', gatewaySmtpHostname: 'smtp.example.test' };
const invalidHosts = ['https://mail.example.test', 'mail.example.test/path', 'mail.example.test:993', 'user@mail.example.test', 'mail.example.test?x=1', 'mail.example.test#x', 'mail.example.test\\x', 'mail.example.test\r\nX: injected', '\tmail.example.test', 'mail.example.test\0', '<script>.example', "mail.example.test'; DROP TABLE setting;--", 'mail..test', '.example.test', 'mail.example.test.', '-mail.example.test', 'mail-.example.test', 'm_ail.example.test', 'máil.example.test', 'localhost', '127.0.0.1', '[::1]', 'a'.repeat(64) + '.test', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`, null, 123];
function safePublic(result) {
	for (const key of ['gatewayHostname', 'secretKey', 'smtpChannels', 'resendTokens', 's3SecretKey', 's3AccessKey', 'tgBotToken', 'webhookSecret', 'githubClientSecret', 'googleClientSecret', 'linuxdoClientSecret']) expect(result).not.toHaveProperty(key);
	expect(JSON.stringify(result)).not.toContain('synthetic-');
}

describe('strict ASCII FQDNs and independent fail-closed display', () => {
	it.each([' Mail.Example.TEST ', 'xn--bcher-kva.example', 'a-b.example', 'a'.repeat(63) + '.test'])('normalizes valid host %s', value => {
		expect(normalizeGatewayHostname(value)).toBe(value.trim().toLowerCase());
	});
	it.each(invalidHosts)('rejects invalid hostname %#', value => expect(() => normalizeGatewayHostname(value)).toThrow());
	it.each(['gatewayImapHostname', 'gatewaySmtpHostname'])('never falls back from missing/empty/invalid %s to legacy', key => {
		for (const value of [undefined, '', 'bad:993', null, 123]) {
			expect(gatewayDisplayConfig({ gatewayEnabled: 1, ...hosts, [key]: value, gatewayHostname: 'legacy.example.test' })).toMatchObject({ gatewayEnabled: 0, [key]: '' });
		}
		expect(gatewayDisplayConfig({ gatewayEnabled: 1, gatewayHostname: 'legacy.example.test' })).toEqual({ gatewayEnabled: 0, gatewayImapHostname: '', gatewaySmtpHostname: '' });
	});
	it('only accepts numeric on and two valid hosts', () => {
		for (const gatewayEnabled of [undefined, '1', true, null, 2, 0]) expect(gatewayDisplayConfig({ gatewayEnabled, ...hosts }).gatewayEnabled).toBe(0);
		expect(gatewayDisplayConfig({ gatewayEnabled: 1, gatewayImapHostname: ' IMAP.Example.TEST ', gatewaySmtpHostname: ' SMTP.Example.TEST ' })).toEqual({ gatewayEnabled: 1, ...hosts });
	});
});

describe('real service with synthetic SQLite/KV', () => {
	it('saves, caches and echoes separate normalized hosts; changing either preserves the other and unrelated settings', async () => {
		const { c, db, values, state } = fixture(); await settingService.refresh(c);
		await settingService.set(c, { gatewayEnabled: 1, gatewayImapHostname: ' IMAP.Example.TEST ', gatewaySmtpHostname: ' SMTP.Example.TEST ' });
		const expected = { gatewayEnabled: 1, ...hosts };
		expect(db.sqlite.prepare('SELECT gateway_enabled,gateway_imap_hostname,gateway_smtp_hostname,title,secret_key FROM setting').get()).toEqual({ gateway_enabled: 1, gateway_imap_hostname: hosts.gatewayImapHostname, gateway_smtp_hostname: hosts.gatewaySmtpHostname, title: 'Synthetic site', secret_key: 'synthetic-turnstile-secret' });
		expect(JSON.parse(values.get(KvConst.SETTING))).toMatchObject(expected);
		state.clear();
		expect(await settingService.get(c)).toMatchObject(expected);
		expect(await settingService.websiteConfig(c)).toMatchObject(expected);
		await settingService.set(c, { gatewayImapHostname: 'imap2.example.test' }); expected.gatewayImapHostname = 'imap2.example.test';
		expect(await settingService.get(c)).toMatchObject(expected);
		await settingService.set(c, { gatewaySmtpHostname: 'smtp2.example.test' }); expected.gatewaySmtpHostname = 'smtp2.example.test';
		await settingService.set(c, { title: 'Updated site' });
		expect(await settingService.websiteConfig(c)).toMatchObject({ ...expected, title: 'Updated site' });
		expect(JSON.parse(values.get(KvConst.SETTING))).toMatchObject(expected);
		await settingService.set(c, { gatewayEnabled: 0 });
		expect(await settingService.get(c)).toMatchObject({ ...expected, gatewayEnabled: 0 });
	});
	it.each(['gatewayImapHostname', 'gatewaySmtpHostname'])('validates %s atomically and requires both hosts before enabling', async key => {
		const { c, db } = fixture(); await settingService.refresh(c);
		await settingService.set(c, { [key]: hosts[key] });
		await expect(settingService.set(c, { gatewayEnabled: 1, title: 'must not write' })).rejects.toThrow();
		for (const value of invalidHosts) await expect(settingService.set(c, { [key]: value, title: 'must not write' })).rejects.toThrow();
		for (const gatewayEnabled of ['1', true, null, 2]) await expect(settingService.set(c, { gatewayEnabled, title: 'must not write' })).rejects.toThrow();
		expect(db.sqlite.prepare('SELECT title,gateway_enabled FROM setting').get()).toEqual({ title: 'Synthetic site', gateway_enabled: 0 });
		await settingService.set(c, { gatewayEnabled: 1, ...hosts });
		await expect(settingService.set(c, { [key]: '' })).rejects.toThrow();
		await settingService.set(c, { gatewayEnabled: 0, [key]: '' });
		expect(await settingService.get(c)).toMatchObject({ gatewayEnabled: 0, [key]: '' });
	});
	it('rejects legacy-only/broad legacy writes without changing split, legacy DB data or other settings', async () => {
		const { c, db } = fixture();
		db.sqlite.exec("ALTER TABLE setting ADD COLUMN gateway_hostname TEXT NOT NULL DEFAULT 'old.example.test'");
		await settingService.refresh(c);
		await expect(settingService.set(c, { gatewayEnabled: 1, gatewayHostname: 'legacy.example.test' })).rejects.toThrow('no longer supported');
		await settingService.set(c, { gatewayEnabled: 1, ...hosts });
		await expect(settingService.set(c, { gatewayHostname: 'old-client.example.test', title: 'must not write' })).rejects.toThrow();
		expect(db.sqlite.prepare('SELECT gateway_hostname,title FROM setting').get()).toEqual({ gateway_hostname: 'old.example.test', title: 'Synthetic site' });
		expect(await settingService.get(c)).toMatchObject({ gatewayEnabled: 1, ...hosts });
		expect(await settingService.get(c)).not.toHaveProperty('gatewayHostname');
		safePublic(await settingService.websiteConfig(c));
	});
	it.each(['gatewayImapHostname', 'gatewaySmtpHostname'])('old KV and raw invalid %s fail closed consistently without losing stored switch', async key => {
		const { c, values, state, db } = fixture(); await settingService.refresh(c);
		const base = JSON.parse(values.get(KvConst.SETTING));
		for (const value of [undefined, null, '', 'bad:993', 123]) {
			const snapshot = { ...base, gatewayEnabled: 1, ...hosts, [key]: value, gatewayHostname: 'legacy.example.test' };
			values.set(KvConst.SETTING, JSON.stringify(snapshot)); state.clear();
			for (const read of [() => settingService.get(c), () => settingService.websiteConfig(c)]) {
				const result = await read(); expect(result).toMatchObject({ gatewayEnabled: 0, [key]: '' }); expect(result).not.toHaveProperty('gatewayHostname');
			}
			expect((await settingService.query(c)).gatewayEnabled).toBe(1);
			await expect(settingService.set(c, { gatewayEnabled: 1 })).rejects.toThrow();
		}
		values.set(KvConst.SETTING, JSON.stringify({ ...base, gatewayEnabled: 1, gatewayHostname: 'legacy.example.test' })); state.clear();
		const result = await settingService.websiteConfig(c);
		expect(result).toMatchObject({ gatewayEnabled: 0, gatewayImapHostname: '', gatewaySmtpHostname: '' }); safePublic(result);
		db.sqlite.exec("UPDATE setting SET gateway_enabled=1,gateway_imap_hostname='bad:993',gateway_smtp_hostname='smtp.example.test'");
		await settingService.refresh(c);
		expect(await settingService.websiteConfig(c)).toMatchObject({ gatewayEnabled: 0, gatewayImapHostname: '' });
		expect(JSON.parse(values.get(KvConst.SETTING))).toMatchObject({ gatewayEnabled: 1, gatewayImapHostname: 'bad:993' });
		await expect(settingService.set(c, { gatewaySmtpHostname: 'smtp2.example.test' })).rejects.toThrow();
	});
	it('explicit off remains off when old stored-on settings receive the new host configuration', async () => {
		const { c, db, values, state } = fixture();
		db.sqlite.exec('UPDATE setting SET gateway_enabled=1');
		await settingService.refresh(c);
		expect(await settingService.get(c)).toMatchObject({ gatewayEnabled: 0, gatewayImapHostname: '', gatewaySmtpHostname: '' });
		await settingService.set(c, { gatewayEnabled: 0, ...hosts });
		expect(db.sqlite.prepare('SELECT gateway_enabled FROM setting').get()).toEqual({ gateway_enabled: 0 });
		expect(JSON.parse(values.get(KvConst.SETTING))).toMatchObject({ gatewayEnabled: 0, ...hosts });
		state.clear();
		expect(await settingService.get(c)).toMatchObject({ gatewayEnabled: 0, ...hosts });
		expect(await settingService.websiteConfig(c)).toMatchObject({ gatewayEnabled: 0, ...hosts });
	});
	it('public output explicitly allowlists only safe settings and masking never mutates source secrets', async () => {
		const { c } = fixture(); await settingService.refresh(c);
		await settingService.set(c, { gatewayEnabled: 1, ...hosts });
		const result = await settingService.websiteConfig(c); safePublic(result);
		expect(result).toMatchObject({ gatewayEnabled: 1, ...hosts, title: 'Synthetic site' });
		expect((await settingService.query(c)).secretKey).toBe('synthetic-turnstile-secret');
	});
	it('keeps real security middleware boundaries for anonymous, ordinary and admin callers', async () => {
		const { c, env, values } = fixture(); await settingService.refresh(c);
		const publicResponse = await app.request('/setting/websiteConfig', {}, env);
		expect((await publicResponse.json()).data).toMatchObject({ gatewayEnabled: 0, gatewayImapHostname: '', gatewaySmtpHostname: '' });
		const makeAuth = email => ({ tokens: [email], user: { userId: email, email }, refreshTime: new Date().toISOString() });
		for (const email of ['ordinary@example.test', env.admin]) values.set(KvConst.AUTH_INFO + email, JSON.stringify(makeAuth(email)));
		const jwt = (await import('../../src/utils/jwt-utils.js')).default;
		jwt.verifyToken = async (_c, token) => token ? { userId: token, token, gen: constant.AUTH_GEN } : null;
		for (const path of ['/setting/query', '/setting/set']) {
			const options = path.endsWith('/set') ? { method: 'PUT', body: JSON.stringify({ gatewayEnabled: 1, ...hosts }), headers: { 'Content-Type': 'application/json' } } : {};
			for (const token of [undefined, 'ordinary@example.test', env.admin]) {
				const response = await app.request(path, { ...options, headers: { ...options.headers, ...(token ? { [constant.TOKEN_HEADER]: token } : {}) } }, env);
				const result = await response.json();
				if (token === env.admin) { expect(result.code).toBe(200); if (path.endsWith('/query')) expect(result.data).not.toHaveProperty('gatewayHostname'); }
				else if (token) expect(result.code).toBe(403);
				else expect(result.code).not.toBe(200);
			}
		}
		expect(JSON.parse(values.get(KvConst.SETTING))).toMatchObject({ gatewayEnabled: 1, ...hosts });
	});
});

describe('independent additive 0003 migration', () => {
	it('fresh init and entity fixture use empty NOT NULL defaults with no old host column', async () => {
		const { db: entityDb } = fixture();
		const db = createSQLiteD1(); databases.push(db); await dbInit.intDB({ env: { db } });
		for (const source of [db, entityDb]) {
			await applyGatewaySplitHostsMigration({ env: { db: source } }); await applyGatewaySplitHostsMigration({ env: { db: source } });
			expect(source.sqlite.prepare('SELECT gateway_imap_hostname,gateway_smtp_hostname FROM setting').get()).toEqual({ gateway_imap_hostname: '', gateway_smtp_hostname: '' });
			const columns = source.sqlite.prepare('PRAGMA table_info(setting)').all();
			expect(columns.some(row => row.name === 'gateway_hostname')).toBe(false);
			for (const row of columns.filter(row => row.name.endsWith('_hostname'))) { expect(row.type).toBe('TEXT'); expect(row.notnull).toBe(1); expect(row.dflt_value).toBe("''"); }
		}
	});
	it('matches one-shot SQL, resumes partial upgrades and never backfills from existing legacy values', async () => {
		const sql = readFileSync(new URL('../../migrations/0003_gateway_split_hosts.sql', import.meta.url), 'utf8');
		expect(sql.split('\n').filter(line => !line.startsWith('--')).join('\n').trim()).toBe(GATEWAY_SPLIT_HOSTS_COLUMNS.map(column => column.sql).join('\n'));
		for (const partial of [false, true]) {
			const db = createSQLiteD1(); databases.push(db);
			db.sqlite.exec("CREATE TABLE setting(title TEXT,gateway_enabled INTEGER,gateway_hostname TEXT); INSERT INTO setting VALUES('Synthetic',1,'legacy.example.test'); CREATE TABLE existing_metadata(id INTEGER); INSERT INTO existing_metadata VALUES(42)");
			if (partial) { db.sqlite.exec(GATEWAY_SPLIT_HOSTS_COLUMNS[0].sql); db.sqlite.exec("UPDATE setting SET gateway_imap_hostname='imap.example.test'"); }
			else db.sqlite.exec(sql);
			await applyGatewaySplitHostsMigration({ env: { db } }); await applyGatewaySplitHostsMigration({ env: { db } });
			expect(db.sqlite.prepare('SELECT * FROM setting').get()).toEqual({ title: 'Synthetic', gateway_enabled: 1, gateway_hostname: 'legacy.example.test', gateway_imap_hostname: partial ? 'imap.example.test' : '', gateway_smtp_hostname: '' });
			expect(db.sqlite.prepare('SELECT * FROM existing_metadata').get()).toEqual({ id: 42 });
			expect(() => db.sqlite.exec('UPDATE setting SET gateway_smtp_hostname=NULL')).toThrow();
		}
	});
	it('reports missing table and actual D1 errors', async () => {
		const db = createSQLiteD1(); databases.push(db);
		await expect(applyGatewaySplitHostsMigration({ env: { db } })).rejects.toThrow('Legacy setting table');
		await expect(applyGatewaySplitHostsMigration({ env: { db: { prepare: () => ({ all: async () => { throw new Error('Synthetic DB failure'); } }) } } })).rejects.toThrow('Synthetic DB failure');
	});
	it('preserves historical 0002 SQL/helper without invoking it during fresh init or 0003', async () => {
		const sql = readFileSync(new URL('../../migrations/0002_gateway_settings.sql', import.meta.url), 'utf8');
		expect(sql.split('\n').filter(line => !line.startsWith('--')).join('\n').trim()).toBe(GATEWAY_SETTINGS_COLUMNS.map(column => column.sql).join('\n'));
		const db = createSQLiteD1(); databases.push(db); db.sqlite.exec("CREATE TABLE setting(title TEXT); INSERT INTO setting VALUES('Synthetic')");
		await applyGatewaySettingsMigration({ env: { db } }); await applyGatewaySettingsMigration({ env: { db } });
		expect(db.sqlite.prepare('SELECT gateway_enabled,gateway_hostname FROM setting').get()).toEqual({ gateway_enabled: 0, gateway_hostname: '' });
	});
});
