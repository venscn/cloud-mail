// Explicit operator tool: no implicit config discovery or production defaults.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GATEWAY_SETTINGS_COLUMNS } from '../src/init/gateway-settings-migration.js';

const args = process.argv.slice(2);
function option(name) {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}
const config = option('--config');
const database = option('--database');
const local = args.includes('--local');
const remote = args.includes('--remote');
if (!config || config.startsWith('--') || !database || database.startsWith('--') || local === remote) {
	console.error('Usage: node scripts/gateway-settings-migration.mjs --config <OPERATOR_CONFIG> --database <D1_NAME_OR_ID> (--local|--remote) [--apply]');
	process.exit(1);
}
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
function execute(sql) {
	const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', database, '--config', config,
		local ? '--local' : '--remote', '--command', sql, '--json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
	// Never dump configuration, database data or potentially sensitive CLI output.
	if (result.error || result.status !== 0) throw new Error('D1 command failed; inspect private operator CLI diagnostics');
	const parsed = JSON.parse(result.stdout);
	if (!Array.isArray(parsed) || parsed.some(item => item.success === false)) throw new Error('D1 returned an unsuccessful command');
	return parsed.flatMap(item => item.results || []);
}
try {
	const rows = execute('PRAGMA table_info(setting);');
	if (!rows.length) throw new Error('Legacy setting table is required');
	const names = new Set(rows.map(row => row.name));
	for (const column of GATEWAY_SETTINGS_COLUMNS) {
		if (names.has(column.name)) console.log(`${column.name}: already present`);
		else if (!args.includes('--apply')) console.log(`${column.name}: missing (plan only; add --apply to migrate)`);
		else { execute(column.sql); console.log(`${column.name}: added`); }
	}
	if (args.includes('--apply')) {
		const verified = new Set(execute('PRAGMA table_info(setting);').map(row => row.name));
		if (GATEWAY_SETTINGS_COLUMNS.some(column => !verified.has(column.name))) throw new Error('Column verification failed');
		console.log('Gateway settings columns verified; refresh settings cache through the authorized application flow.');
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
