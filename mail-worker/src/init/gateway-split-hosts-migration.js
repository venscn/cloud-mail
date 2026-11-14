// Independent 0003 upgrade; never replays 0001/0002 or copies legacy host values.
export const GATEWAY_SPLIT_HOSTS_COLUMNS = [
	{ name: 'gateway_imap_hostname', sql: "ALTER TABLE setting ADD COLUMN gateway_imap_hostname TEXT NOT NULL DEFAULT '';" },
	{ name: 'gateway_smtp_hostname', sql: "ALTER TABLE setting ADD COLUMN gateway_smtp_hostname TEXT NOT NULL DEFAULT '';" }
];

export async function applyGatewaySplitHostsMigration({ env: { db } }) {
	const { results } = await db.prepare('PRAGMA table_info(setting)').all();
	if (!results.length) throw new Error('Legacy setting table is required');
	const columns = new Set(results.map(row => row.name));
	for (const column of GATEWAY_SPLIT_HOSTS_COLUMNS) {
		if (!columns.has(column.name)) await db.prepare(column.sql).run();
	}
}
