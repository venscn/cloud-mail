import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Deliberately isolated from production Wrangler bindings, credentials and deployment scripts.
export default defineWorkersConfig({
	test: {
		include: ['test/sender-identity.test.js'],
		poolOptions: {
			workers: {
				miniflare: {
					compatibilityDate: '2025-03-10',
					compatibilityFlags: ['nodejs_compat']
				}
			}
		}
	}
});
