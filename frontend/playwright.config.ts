import { defineConfig, devices } from '@playwright/test'

// E2E 는 실행 중인 백엔드(:9522, 모델 스텁) + vite dev(:9502)를 전제한다(quickstart §5).
// 브라우저는 `npx playwright install chromium` 으로 별도 설치한다.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:9502',
    trace: 'retain-on-failure',
    locale: 'ko-KR',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : { command: 'npm run dev', url: 'http://127.0.0.1:9502', reuseExistingServer: true, timeout: 60_000 },
})
