import { defineConfig } from 'vitest/config';

// Plain Node + real in-memory/file-backed SQLite. No production Wrangler config,
// Cloudflare credentials, remote mail delivery, bucket or database is loaded.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/gateway-core/**/*.test.js'],
		fileParallelism: false,
		testTimeout: 15000
	}
});
