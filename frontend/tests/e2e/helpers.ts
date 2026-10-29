import { expect, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** quickstart §5 의 표본 파일 위치. backend/tests/fixtures 가 기본, E2E_FIXTURES 로 바꿀 수 있다 */
export const FIXTURES = process.env.E2E_FIXTURES ?? resolve(here, '../../../backend/tests/fixtures')
export const fixture = (rel: string) => resolve(FIXTURES, rel)
export const hasFixture = (rel: string) => existsSync(fixture(rel))

export const SAMPLE_TEXT = `구독 서비스 이용약관
제1조(목적) 이 약관은 회사가 제공하는 온라인 강의 구독 서비스의 이용 조건을 정한다.
제7조(가격 변경) 회사는 이용료를 회원에게 통지하지 않고 변경할 수 있다.
제12조(위약금) 1. 회원이 중도 해지하면 잔여 기간 이용료의 3배를 위약금으로 낸다.
2. 회원은 제1항의 금액을 해지일부터 7일 안에 낸다.
제18조(해지) 회사는 사유를 불문하고 언제든지 계약을 해지할 수 있다.`

export function startButton(page: Page) {
  return page.locator('[data-c="C3"] button', { hasText: '분석 시작' })
}

/** S1 → S2 → S3 → S4 한 바퀴(스텁 모델 서버 기준). 결과 URL 을 돌려준다 */
export async function runAnalysis(page: Page, opts: { file?: string } = {}) {
  await page.goto('/')
  if (opts.file) {
    await page.locator('[data-part="file-input"]').setInputFiles(opts.file)
    await expect(page.locator('[data-check="format"]')).toContainText('통과')
  } else {
    await page.getByRole('tab', { name: '텍스트 붙여넣기' }).click()
    await page.locator('#text-input').fill(SAMPLE_TEXT)
  }
  await expect(startButton(page)).not.toHaveAttribute('aria-disabled', 'true')
  await startButton(page).click()

  await page.waitForURL(/\/analyses\/\d+\/structuring/)
  const confirm = page.locator('[data-c="C3"] button', { hasText: '계약 유형 확정' })
  await expect(confirm).not.toHaveAttribute('aria-disabled', 'true', { timeout: 180_000 })
  const select = page.locator('[data-part="contract-type"]').first()
  if (!(await select.inputValue())) await select.selectOption('subscription')
  await confirm.click()

  await page.waitForURL(/\/analyses\/\d+\/detection/)
  await expect(page.locator('[data-part="progress"]')).toContainText(/조항 \d+개 중 \d+개 점수|조항을 모으는 중/)
  const view = page.locator('[data-c="C3"] button', { hasText: /결과 보기/ })
  await expect(view).not.toHaveAttribute('aria-disabled', 'true', { timeout: 180_000 })
  await expect(page.locator('[data-part="done"]')).toContainText('분석이 끝났습니다')
  await view.click()
  await page.waitForURL(/\/results\/\d+/)
  return page.url()
}

/** 첫 위험 조항(원문 하이라이트)을 고른다 */
export async function selectFirstRiskClause(page: Page) {
  const hl = page.locator('[data-part="source"] button.hl').first()
  await hl.click()
  await expect(page.locator('[data-part="detail"]')).toBeVisible()
}

/** 개발용 로그인(dev 제공자, 백엔드 AUTH_DEV_PROVIDER=true) — 매번 새 계정(role user). 역할은 admin:grant-role 로 */
export async function loginDev(page: Page, subject = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  await page.goto(`/api/auth/dev/start?devSubject=${subject}&returnTo=/`)
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'))
}
