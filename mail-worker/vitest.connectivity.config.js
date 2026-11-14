import { defineConfig } from 'vitest/config';
// Synthetic offline tests only. Never load Wrangler or deployment initialization.
export default defineConfig({test:{environment:'node',include:['test/connectivity/**/*.test.js'],fileParallelism:false,testTimeout:15000}});
