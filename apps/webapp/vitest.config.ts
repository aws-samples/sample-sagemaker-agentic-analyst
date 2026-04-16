import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    env: {
      POWERTOOLS_LOG_LEVEL: 'WARN',
    },
    environment: 'node',
    pool: 'forks',
    maxConcurrency: 1,
    testTimeout: 30000,
    reporters: ['dot'],
    outputFile: undefined,
    silent: 'passed-only',
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
