import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test file builds its own in-memory database (see TEST_STRATEGY.md §8),
    // so files are isolated by construction and may run in parallel.
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
