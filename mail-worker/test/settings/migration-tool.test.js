import { afterEach, expect, it, vi } from 'vitest';
import { createSQLiteD1 } from '../gateway-core/sqlite-adapter.js';

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));
const originalArgv = process.argv;
let db;
afterEach(() => {
	process.argv = originalArgv;
	process.exitCode = 0;
	db?.close(); db = undefined;
	vi.restoreAllMocks();
	vi.resetModules();
});

async function runTool(apply) {
	process.argv = ['node', 'gateway-settings-migration.mjs', '--config', 'synthetic-operator.toml', '--database', 'synthetic-settings', '--local', ...(apply ? ['--apply'] : [])];
	vi.spyOn(console, 'log').mockImplementation(() => {});
	mocked.spawnSync.mockImplementation((_node, args) => {
		expect(args).toContain('synthetic-operator.toml');
		expect(args).toContain('--local');
		expect(args).not.toContain('--remote');
		const sql = args[args.indexOf('--command') + 1];
		const statement = db.sqlite.prepare(sql);
		const results = statement.columns().length ? statement.all() : (statement.run(), []);
		return { status: 0, stdout: JSON.stringify([{ success: true, results }]) };
	});
	await import('../../scripts/gateway-settings-migration.mjs');
}

it('operator tool defaults to schema-only plan and adds no columns without --apply', async () => {
	db = createSQLiteD1(); db.sqlite.exec('CREATE TABLE setting(title TEXT)');
	await runTool(false);
	expect(db.sqlite.prepare('PRAGMA table_info(setting)').all().map(row => row.name)).toEqual(['title']);
	expect(mocked.spawnSync).toHaveBeenCalledTimes(1);
});

it('operator tool resumes a partial upgrade and repeated --apply preserves configuration', async () => {
	db = createSQLiteD1();
	db.sqlite.exec("CREATE TABLE setting(title TEXT, gateway_enabled INTEGER NOT NULL DEFAULT 0); INSERT INTO setting VALUES('Synthetic title',1)");
	await runTool(true);
	expect(db.sqlite.prepare('SELECT * FROM setting').get()).toMatchObject({ title: 'Synthetic title', gateway_enabled: 1, gateway_hostname: '' });
	db.sqlite.exec("UPDATE setting SET gateway_hostname='mail.example.test'");
	vi.resetModules(); mocked.spawnSync.mockClear();
	await runTool(true);
	expect(mocked.spawnSync).toHaveBeenCalledTimes(2);
	expect(db.sqlite.prepare('SELECT gateway_hostname FROM setting').get().gateway_hostname).toBe('mail.example.test');
});
