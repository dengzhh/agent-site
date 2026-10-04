import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 范围钉在 src/scripts：防止 vitest 扫到 packages/*（agent-server 用 node:test）
    include: ['src/**/*.test.*', 'scripts/**/*.test.*'],
    passWithNoTests: true,
  },
});
