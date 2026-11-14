import { defineConfig } from 'vitest/config';

// Offline Node/SQLite synthetic settings tests. Never load any Wrangler config.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/settings/**/*.test.js'],
		fileParallelism: false,
		testTimeout: 15000
	}
});
