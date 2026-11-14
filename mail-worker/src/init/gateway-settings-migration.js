// Separate from the already-deployed 0001 gateway protocol migration.
export const GATEWAY_SETTINGS_COLUMNS = [
	{ name: 'gateway_enabled', sql: 'ALTER TABLE setting ADD COLUMN gateway_enabled INTEGER NOT NULL DEFAULT 0 CHECK (gateway_enabled IN (0, 1));' },
	{ name: 'gateway_hostname', sql: "ALTER TABLE setting ADD COLUMN gateway_hostname TEXT NOT NULL DEFAULT '';" }
];

// Explicit initializer/operator action only, never ordinary Worker startup.
// Check each column separately so a partially applied migration can be resumed.
export async function applyGatewaySettingsMigration({ env: { db } }) {
	const { results } = await db.prepare('PRAGMA table_info(setting)').all();
	if (!results.length) throw new Error('Legacy setting table is required');
	const columns = new Set(results.map(row => row.name));
	for (const column of GATEWAY_SETTINGS_COLUMNS) {
		if (!columns.has(column.name)) await db.prepare(column.sql).run();
	}
}
