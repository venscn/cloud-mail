import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Deliberately isolated from production Wrangler bindings, credentials and deployment scripts.
export default defineWorkersConfig({
	test: {
		include: ['test/sender-identity.test.js', 'test/gateway-submission*.test.js'],
		exclude: ['test/gateway-submission-smtp-transport.test.js'],
		poolOptions: {
			workers: {
				miniflare: {
					d1Databases: ['SUBMISSION_TEST_DB', 'SUBMISSION_STAGING_TEST_DB'],
					compatibilityDate: '2025-03-10',
					compatibilityFlags: ['nodejs_compat']
				}
			}
		}
	}
});
