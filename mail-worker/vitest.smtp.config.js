import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// No Wrangler configuration or live bindings. Alias only cloudflare:sockets;
// inline the installed dependency so its native-module import uses this alias.
export default defineConfig({
	resolve: { alias: {
		'cloudflare:sockets': fileURLToPath(new URL('./test/helpers/synthetic-smtp-sockets.js', import.meta.url)),
		'worker-mailer': fileURLToPath(new URL('./node_modules/worker-mailer/dist/index.mjs', import.meta.url))
	} },
	test: {
		environment: 'node',
		include: ['test/gateway-submission-smtp-transport.test.js'],
		server: { deps: { inline: ['worker-mailer'] } }
	}
});
