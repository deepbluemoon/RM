// T096 — quickstart §5 #7·#8 (US2 설명·근거 비교)
import { test, expect } from '@playwright/test'
import { loginDev, runAnalysis, selectFirstRiskClause } from './helpers'

const ASSERTIVE = /(위법이다|불법이다|무효이다|반드시 무효|확실히)/

test.describe('US2 검토 포인트·표준약관 대비 차이(사업자 뷰 S4-B)', () => {
  test.beforeEach(async ({ page }) => {
    await loginDev(page)
    await runAnalysis(page)
    await selectFirstRiskClause(page)
  })

  test('#7 검토 포인트 — 주장마다 연결 근거 강조, 단정 표현 없음', async ({ page }) => {
    const tab = page.locator('[data-tab="explain"]')
    if ((await tab.getAttribute('aria-disabled')) === 'true') {
      // G9: 설명 탭만 막히고 판정·근거는 유지된다
      await expect(page.locator('[data-panel="verdict"] [data-gate="G9"]')).toContainText('설명 제공 불가')
      await expect(page.locator('[data-panel="verdict"] [data-c="C6"]').first()).toBeVisible()
      return
    }
    await tab.click()
    const claims = page.locator('[data-panel="explain"] [data-claim]')
    await expect(claims.first()).toBeVisible()
    const n = await claims.count()
    for (let i = 0; i < n; i++) {
      const c = claims.nth(i)
      expect(await c.innerText()).not.toMatch(ASSERTIVE)
      await c.click()
      await expect(c).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('[data-panel="explain"] .chip.lit')).toHaveCount(1)
    }
    // 4.12 탭에서 목록으로 돌아와도 선택·목록 위치 유지
    const selected = await page.locator('[data-part="risk-list"] [aria-current="true"]').getAttribute('data-list-item')
    await page.locator('[data-tab="verdict"]').click()
    await expect(page.locator(`[data-part="risk-list"] [data-list-item="${selected}"]`)).toHaveAttribute('aria-current', 'true')
  })

  test('#8 표준약관 대비 차이 — 자사 약관 조항 ↔ 법령 조문·표준약관 좌우', async ({ page }) => {
    await page.locator('[data-tab="compare"]').click()
    const cmp = page.locator('[data-panel="compare"] .compare')
    await expect(cmp).toBeVisible()
    await expect(cmp.locator('.col-head').first()).toHaveText('자사 약관 조항')
    await expect(cmp.locator('.col-head').nth(1)).toContainText(/법령 조문|표준약관/)
    // 좌우 배치(1280px)
    const [a, b] = await Promise.all([cmp.locator('> div').nth(0).boundingBox(), cmp.locator('> div').nth(1).boundingBox()])
    expect(b!.x).toBeGreaterThan(a!.x)
    expect(Math.abs(b!.y - a!.y)).toBeLessThan(4)
    const std = page.locator('[data-panel="compare"] [data-mode="std"] button')
    if ((await std.getAttribute('aria-disabled')) !== 'true') {
      await std.click()
      await expect(cmp.locator('.col-head').nth(1)).toContainText('표준약관')
    } else {
      await expect(page.locator('[data-panel="compare"] [data-mode="std"] .reason')).toContainText('표준약관 대응 조항 없음')
    }
    // 좁은 화면(≤768px)에서는 위아래
    await page.setViewportSize({ width: 360, height: 800 })
    const [c, d] = await Promise.all([cmp.locator('> div').nth(0).boundingBox(), cmp.locator('> div').nth(1).boundingBox()])
    expect(d!.y).toBeGreaterThan(c!.y + c!.height - 1)
  })

  test('유사 사례 — 3구분 또는 "유사 사례 없음"', async ({ page }) => {
    await page.locator('[data-tab="cases"]').click()
    const panel = page.locator('[data-panel="cases"]')
    // 처리 중 자리표시(C7)가 먼저 보인다 — 실모델·실DB 에서는 조회가 늦게 끝나므로 결과가 올 때까지 기다린다
    await expect(panel).not.toContainText('진행 중')
    await expect(panel.locator('[data-case], [data-c="C7"]').first()).toBeVisible()
    if (await panel.locator('[data-case]').count()) {
      await expect(panel.locator('[data-case]').first()).toContainText('사실관계 요약')
      await expect(panel.locator('[data-case]').first()).toContainText('공정위 판단')
      await expect(panel.locator('[data-case]').first()).toContainText('판단 근거')
    } else {
      await expect(panel).toContainText('유사 사례 없음')
    }
  })
})
