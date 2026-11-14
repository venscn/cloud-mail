import { afterEach, expect, it, vi } from 'vitest';
import { createSQLiteD1 } from '../gateway-core/sqlite-adapter.js';

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));
const originalArgv = process.argv;
let db;
afterEach(() => {
	process.argv = originalArgv; process.exitCode = 0;
	db?.close(); db = undefined;
	vi.restoreAllMocks(); vi.resetModules(); mocked.spawnSync.mockReset();
});
async function runTool(apply, failure = false) {
	process.argv = ['node', 'gateway-split-hosts-migration.mjs', '--config', 'synthetic-operator.toml', '--database', 'synthetic-settings', '--local', ...(apply ? ['--apply'] : [])];
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mocked.spawnSync.mockImplementation((_node, args) => {
		expect(args).toContain('synthetic-operator.toml'); expect(args).toContain('--local'); expect(args).not.toContain('--remote');
		const sql = args[args.indexOf('--command') + 1];
		// Proves this tool cannot replay 0001/0002, read settings rows or touch mail.
		expect(sql).toMatch(/^(PRAGMA table_info\(setting\);|ALTER TABLE setting ADD COLUMN gateway_(imap|smtp)_hostname TEXT NOT NULL DEFAULT '';)$/);
		if (failure) return { status: 1, stdout: 'synthetic-private-cli-output' };
		const statement = db.sqlite.prepare(sql);
		const results = statement.columns().length ? statement.all() : (statement.run(), []);
		return { status: 0, stdout: JSON.stringify([{ success: true, results }]) };
	});
	await import('../../scripts/gateway-split-hosts-migration.mjs');
}
function setup() {
	db = createSQLiteD1();
	db.sqlite.exec("CREATE TABLE setting(title TEXT,gateway_enabled INTEGER,gateway_hostname TEXT); INSERT INTO setting VALUES('Synthetic',1,'legacy.example.test')");
}
it('defaults to a schema-only plan without applying any column', async () => {
	setup(); await runTool(false);
	expect(db.sqlite.prepare('PRAGMA table_info(setting)').all().map(row => row.name)).toEqual(['title', 'gateway_enabled', 'gateway_hostname']);
	expect(mocked.spawnSync).toHaveBeenCalledTimes(1);
});
it('applies only 0003 and can repeat or resume a partial application without changing source values', async () => {
	setup(); db.sqlite.exec("ALTER TABLE setting ADD COLUMN gateway_imap_hostname TEXT NOT NULL DEFAULT ''; UPDATE setting SET gateway_imap_hostname='imap.example.test'");
	await runTool(true);
	expect(db.sqlite.prepare('SELECT * FROM setting').get()).toEqual({ title: 'Synthetic', gateway_enabled: 1, gateway_hostname: 'legacy.example.test', gateway_imap_hostname: 'imap.example.test', gateway_smtp_hostname: '' });
	db.sqlite.exec("UPDATE setting SET gateway_smtp_hostname=''");
	vi.resetModules(); mocked.spawnSync.mockClear();
	await runTool(true);
	expect(mocked.spawnSync).toHaveBeenCalledTimes(2);
	expect(db.sqlite.prepare('SELECT gateway_imap_hostname,gateway_smtp_hostname FROM setting').get()).toEqual({ gateway_imap_hostname: 'imap.example.test', gateway_smtp_hostname: '' });
});
it('adds both columns to a 0002 schema with empty defaults on existing rows', async () => {
	setup(); await runTool(true);
	expect(mocked.spawnSync).toHaveBeenCalledTimes(4);
	expect(db.sqlite.prepare('SELECT gateway_imap_hostname,gateway_smtp_hostname FROM setting').get()).toEqual({ gateway_imap_hostname: '', gateway_smtp_hostname: '' });
});
it('refuses to replay missing 0002 and does not hide real CLI failures or print private output', async () => {
	db = createSQLiteD1(); db.sqlite.exec('CREATE TABLE setting(title TEXT)');
	await runTool(true);
	expect(process.exitCode).toBe(1); expect(mocked.spawnSync).toHaveBeenCalledTimes(1);
	expect(console.error).toHaveBeenCalledWith(expect.stringContaining('gateway_enabled'));
	vi.resetModules(); mocked.spawnSync.mockClear(); process.exitCode = 0;
	await runTool(true, true);
	expect(process.exitCode).toBe(1);
	expect(console.error).toHaveBeenCalledWith('D1 command failed; inspect private operator CLI diagnostics');
	expect(JSON.stringify(console.error.mock.calls)).not.toContain('synthetic-private-cli-output');
});
