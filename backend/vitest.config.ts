import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 통합 테스트는 같은 crd_test DB 를 쓰므로 파일 단위로 순차 실행한다
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    setupFiles: ['tests/setup-env.ts'],
  },
});
