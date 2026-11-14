import { defineConfig } from 'vitest/config';

// Deliberately independent of Wrangler and of the deploy-oriented npm test task.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/gateway-integration/**/*.test.js'],
		pool: 'forks',
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1,
		testTimeout: 180000,
		hookTimeout: 20000
	}
});
