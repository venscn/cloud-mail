// Offline-only SQL mirror generator. Never reads Wrangler, credentials or bindings.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GATEWAY_MIGRATION } from '../src/gateway/schema.js';

const destination = new URL('../migrations/0001_gateway_v1.sql', import.meta.url);
const expected = [
	'-- Generated from src/gateway/schema.js; do not hand-edit.',
	'-- Requires the existing Cloud Mail v3.7 legacy schema first.',
	'-- Repeatable and additive. The Worker never applies this on normal startup.',
	'-- Generate offline: node scripts/gateway-migration.mjs --write',
	'', GATEWAY_MIGRATION.map(statement => statement.trim()).join('\n\n'), ''
].join('\n');
if (process.argv.length !== 3 || !['--write', '--check'].includes(process.argv[2])) {
	console.error('Usage: node scripts/gateway-migration.mjs --check|--write');
	process.exitCode = 2;
} else if (process.argv[2] === '--write') {
	await mkdir(new URL('../migrations/', import.meta.url), { recursive: true });
	await writeFile(destination, expected, 'utf8');
	console.log(`Generated ${fileURLToPath(destination)}`);
} else {
	const actual = await readFile(destination, 'utf8');
	if (actual !== expected) { console.error('Gateway SQL mirror differs from the canonical migration; regenerate it.'); process.exitCode = 1; }
	else console.log('Gateway SQL mirror matches the canonical migration.');
}
