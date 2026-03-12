import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 20000,
    include: ['tests/**/*.test.{js,ts}'],
    setupFiles: ['tests/setup.js'],
  },
});
