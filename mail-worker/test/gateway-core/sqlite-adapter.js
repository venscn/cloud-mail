// Local-only D1 adapter. Uses a real SQLite engine, transactions and triggers;
// never loads Wrangler, production config, a provider SDK or a network binding.
import { DatabaseSync } from 'node:sqlite';
import { applyGatewayMigration } from '../../src/gateway/schema.js';

export function createSQLiteD1(filename = ':memory:') {
	const sqlite = new DatabaseSync(filename);
	sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=5000;');
	class Statement {
		constructor(sql, parameters = []) { this.sql = sql; this.parameters = parameters; }
		bind(...parameters) { return new Statement(this.sql, parameters); }
		execute() {
			const statement = sqlite.prepare(this.sql);
			let results = [], info;
			if (statement.columns().length) {
				results = statement.all(...this.parameters).map(row => ({ ...row }));
				info = sqlite.prepare('SELECT changes() AS changes,last_insert_rowid() AS lastInsertRowid').get();
			} else info = statement.run(...this.parameters);
			return { success: true, results, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid), duration: 0 } };
		}
		async run() { return this.execute(); }
		async all() { return this.execute(); }
		async first(column) { const row = this.execute().results[0] || null; return column && row ? row[column] : row; }
		async raw() { return this.execute().results.map(Object.values); }
	}
	return {
		sqlite,
		prepare: sql => new Statement(sql),
		async batch(statements) {
			sqlite.exec('BEGIN IMMEDIATE');
			try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; }
			catch (error) { sqlite.exec('ROLLBACK'); throw error; }
		},
		async exec(sql) { sqlite.exec(sql); return { count: 1, duration: 0 }; },
		close() { sqlite.close(); }
	};
}

export const LEGACY_SCHEMA = `
CREATE TABLE user(user_id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,type INTEGER NOT NULL DEFAULT 1,password TEXT NOT NULL DEFAULT '',salt TEXT NOT NULL DEFAULT '',status INTEGER NOT NULL DEFAULT 0,is_del INTEGER NOT NULL DEFAULT 0);
CREATE TABLE account(account_id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,email TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',status INTEGER NOT NULL DEFAULT 0,is_del INTEGER NOT NULL DEFAULT 0,latest_email_time TEXT,create_time TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE role(role_id INTEGER PRIMARY KEY,name TEXT,key TEXT,avail_domain TEXT DEFAULT '',ban_email TEXT DEFAULT '',send_type TEXT DEFAULT 'day',send_count INTEGER DEFAULT 100,account_count INTEGER DEFAULT 10);
CREATE TABLE perm(perm_id INTEGER PRIMARY KEY,perm_key TEXT,type INTEGER DEFAULT 2);
CREATE TABLE role_perm(id INTEGER PRIMARY KEY AUTOINCREMENT,role_id INTEGER,perm_id INTEGER);
CREATE TABLE email(email_id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL,user_id INTEGER NOT NULL,type INTEGER NOT NULL DEFAULT 0,status INTEGER NOT NULL DEFAULT 0,is_del INTEGER NOT NULL DEFAULT 0,unread INTEGER NOT NULL DEFAULT 0,create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 send_email TEXT DEFAULT '',name TEXT DEFAULT '',to_email TEXT DEFAULT '',to_name TEXT DEFAULT '',subject TEXT DEFAULT '',content TEXT DEFAULT '',text TEXT DEFAULT '',recipient TEXT DEFAULT '[]',cc TEXT DEFAULT '[]',bcc TEXT DEFAULT '[]',message_id TEXT DEFAULT '',in_reply_to TEXT DEFAULT '',relation TEXT DEFAULT '',sender_email TEXT DEFAULT '',code TEXT DEFAULT '',resend_email_id TEXT DEFAULT '',message TEXT DEFAULT '',resend_id TEXT DEFAULT '',sent_time TEXT,delivered_time TEXT,send_account_id INTEGER);
CREATE TABLE star(star_id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,email_id INTEGER NOT NULL,create_time TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE attachments(att_id INTEGER PRIMARY KEY AUTOINCREMENT,email_id INTEGER NOT NULL,account_id INTEGER NOT NULL,user_id INTEGER NOT NULL,key TEXT NOT NULL,filename TEXT,mime_type TEXT,size INTEGER,disposition TEXT,content_id TEXT,encoding TEXT,type INTEGER DEFAULT 0,status INTEGER DEFAULT 0,related TEXT,create_time TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO role(role_id,name,avail_domain) VALUES(1,'Synthetic user','example.test');
INSERT INTO perm(perm_id,perm_key) VALUES(1,'account:query'),(2,'email:send'),(3,'email:delete');
INSERT INTO role_perm(role_id,perm_id) VALUES(1,1),(1,2),(1,3);
INSERT INTO user(user_id,email) VALUES(1,'alice@example.test'),(2,'bob@example.test');
INSERT INTO account(account_id,user_id,email,name) VALUES(1,1,'alice@example.test','Alice'),(2,2,'bob@example.test','Bob');
`;

export function createMemoryR2() {
	const objects = new Map();
	return { objects,
		async put(key, value, options = {}) {
			const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer());
			const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
			if (options.sha256 && options.sha256 !== checksum) throw new Error('R2 SHA-256 mismatch');
			objects.set(key, { bytes, checksum, httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {} });
			return { key, size: bytes.byteLength };
		},
		async get(key, options = {}) {
			const object = objects.get(key);
			if (!object) return null;
			const bytes = options?.range ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length) : object.bytes.slice();
			const checksum = object.checksum || [...new Uint8Array(await crypto.subtle.digest('SHA-256', object.bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
			const sha256 = Uint8Array.from(checksum.match(/../g), n => parseInt(n, 16)).buffer;
			return { key, size: object.bytes.byteLength, range: options?.range, checksums: { sha256 }, customMetadata: object.customMetadata, httpMetadata: object.httpMetadata, body: new Response(bytes).body, arrayBuffer: async () => bytes.buffer };
		},
		async delete(key) { objects.delete(key); }
	};
}

export async function createSyntheticEnvironment({ migrate = true, filename = ':memory:' } = {}) {
	const db = createSQLiteD1(filename);
	db.sqlite.exec(LEGACY_SCHEMA);
	const env = { db, r2: createMemoryR2(), domain: ['example.test'], admin: 'admin@example.test' };
	if (migrate) await applyGatewayMigration({ env });
	return env;
}
