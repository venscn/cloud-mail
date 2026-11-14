import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createSQLiteD1, LEGACY_SCHEMA } from './sqlite-adapter.js';
import { GATEWAY_MIGRATION, applyGatewayMigration } from '../../src/gateway/schema.js';

const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const sql = readFileSync(new URL('../../migrations/0001_gateway_v1.sql', import.meta.url), 'utf8');
const body = sql.split('\n').filter(line => !line.startsWith('--')).join('\n').trim();

describe('explicit gateway migration artifacts', () => {
	it('keeps the operator SQL mirror identical to canonical statement content and order', () => {
		expect(body).toBe(GATEWAY_MIGRATION.map(statement => statement.trim()).join('\n\n'));
		expect(sql).not.toContain('\r');
		expect(sql.endsWith('\n') && !sql.endsWith('\n\n')).toBe(true);
		// D1 compiles nested trigger programs under a low compound SELECT limit.
		// Default folders must not reintroduce UNION ALL chains.
		expect(GATEWAY_MIGRATION.filter(statement => statement.includes("('INBOX','\\Inbox')")).length).toBeGreaterThan(0);
		expect(GATEWAY_MIGRATION.some(statement => /UNION ALL/.test(statement))).toBe(false);
	});
	it('applies the standalone SQL twice without resetting UIDs, revision, credentials or messages', async () => {
		const db = createSQLiteD1(); databases.push(db); db.sqlite.exec(LEGACY_SCHEMA);
		db.sqlite.exec(sql);
		db.sqlite.exec("INSERT INTO email(account_id,user_id,text) VALUES(1,1,'Synthetic historical body');");
		db.sqlite.exec("INSERT INTO gateway_credentials(id,user_id,account_id,name,password_hash,permissions,created_at) VALUES('migration-fixture',1,1,'Synthetic fixture','not-an-authentic-password-hash','[\"mail.read\"]',0);");
		const before = db.sqlite.prepare('SELECT id,uid,mod_seq FROM gateway_messages').all();
		const boxes = db.sqlite.prepare('SELECT id,name,uid_next,highest_mod_seq FROM gateway_mailboxes ORDER BY id').all();
		const accounts = db.sqlite.prepare('SELECT * FROM gateway_accounts ORDER BY account_id').all();
		const credentials = db.sqlite.prepare('SELECT * FROM gateway_credentials ORDER BY id').all();
		db.sqlite.exec(sql);
		await applyGatewayMigration({ env: { db } });
		expect(db.sqlite.prepare('SELECT id,uid,mod_seq FROM gateway_messages').all()).toEqual(before);
		expect(db.sqlite.prepare('SELECT id,name,uid_next,highest_mod_seq FROM gateway_mailboxes ORDER BY id').all()).toEqual(boxes);
		expect(db.sqlite.prepare('SELECT * FROM gateway_accounts ORDER BY account_id').all()).toEqual(accounts);
		expect(db.sqlite.prepare('SELECT * FROM gateway_credentials ORDER BY id').all()).toEqual(credentials);
		expect(db.sqlite.prepare("SELECT value FROM gateway_meta WHERE key='schema_version'").get().value).toBe('1');
		db.sqlite.exec("INSERT INTO account(account_id,user_id,email) VALUES(3,1,'third@example.test');");
		expect(db.sqlite.prepare('SELECT name FROM gateway_mailboxes WHERE account_id=3 ORDER BY id').all().map(row => row.name)).toEqual(['INBOX','Sent','Drafts','Trash','Archive','Junk']);
	});
	it('rolls back an unsuccessful canonical batch instead of marking a partial migration ready', async () => {
		const db = createSQLiteD1(); databases.push(db);
		await expect(applyGatewayMigration({ env: { db } })).rejects.toThrow();
		expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'gateway_%'").all()).toEqual([]);
	});
});
