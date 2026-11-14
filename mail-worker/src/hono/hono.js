import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';
import { GatewayError, safeGatewayError } from '../gateway/errors.js';

app.use('*', cors());

app.onError((err, c) => {
	// Management routes keep the legacy Result envelope, but never hide an
	// authentication failure behind HTTP 200 or expose internal exception text.
	if (c.req.path === '/gateway' || c.req.path.startsWith('/gateway/')) {
		const safe = safeGatewayError(err.name === 'BizError' && [401, 403].includes(err.code)
			? new GatewayError(err.code, err.code === 401 ? 'SESSION_INVALID' : 'FORBIDDEN', err.code === 401 ? 'Invalid or expired web session' : 'Not permitted') : err);
		c.header('Cache-Control', 'no-store');
		return c.json(result.fail(safe.message, safe.status), safe.status);
	}
	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定<br/>D1 database not bound',502));
	}

	if (err.message?.includes('D1_ERROR: no such column')) {
		return c.json(result.fail('请按照文档更新数据库<br/>Please update the database as documented',502));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;


