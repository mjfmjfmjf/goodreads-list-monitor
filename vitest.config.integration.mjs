import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/integration/*.integration.ts'],
  },
});
