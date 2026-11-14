import app from '../hono/hono.js';
import { probeGateway } from '../service/gateway-connectivity.js';

// Registered after the actual web JWT middleware, not the bearer gateway router.
app.post('/setting/gatewayConnectivity/:protocol', async c => {
	c.header('Cache-Control','no-store');
	const reply = (code,status) => c.json({code:status, message:code, data:null},status);
	const user = c.get('user');
	if (!user || !c.env.admin || user.email !== c.env.admin) return reply('FORBIDDEN',403);
	const protocol = c.req.param('protocol');
	if (!['imap','smtp'].includes(protocol) || new URL(c.req.url).search) return reply('INVALID_REQUEST',400);
	try {
		// No body accepted: the browser cannot supply a destination or port, even as extra fields.
		if (c.req.raw.body !== null) { void c.req.raw.body.cancel().catch(() => {}); return reply('INVALID_REQUEST',400); }
		// Atomic, global per-protocol cooldown across isolates. No credentials/mail tables read.
		await c.env.db.prepare('CREATE TABLE IF NOT EXISTS gateway_probe_cooldown (protocol TEXT PRIMARY KEY, until_ms INTEGER NOT NULL)').run();
		const now = Date.now();
		const granted = await c.env.db.prepare('INSERT INTO gateway_probe_cooldown(protocol,until_ms) VALUES (?,?) ON CONFLICT(protocol) DO UPDATE SET until_ms=excluded.until_ms WHERE gateway_probe_cooldown.until_ms<=? RETURNING protocol')
			.bind(protocol,now+60000,now).first();
		if (!granted) { c.header('Retry-After','60'); return reply('RATE_LIMITED',429); }
		const column = protocol === 'imap' ? 'gateway_imap_hostname' : 'gateway_smtp_hostname';
		const row = await c.env.db.prepare(`SELECT ${column} AS hostname FROM setting LIMIT 1`).first();
		const { connect } = await import('cloudflare:sockets');
		const data = await probeGateway(protocol,row?.hostname,{connect, signal:c.req.raw.signal});
		return c.json({code:200,message:'',data});
	} catch { return reply('UNAVAILABLE',503); }
});
