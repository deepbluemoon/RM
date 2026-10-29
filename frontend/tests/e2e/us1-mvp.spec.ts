// T063 — quickstart §5 #1~#6 + 게이트 G2·G5·G8 (US1 MVP) — 로컬 사업자 검증 모드: 이용 한도 없음, 관점 사업자 고정. 로그인(RBAC) — 각 테스트는 dev 로그인한 새 사용자
// 전제: backend :9522 + tools/model-api-stub, vite :9502. 실행: `npm run e2e` (브라우저는 별도 설치)
import { writeFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { hasFixture, fixture, loginDev, runAnalysis, selectFirstRiskClause, startButton } from './helpers'

test.beforeEach(async ({ page }) => loginDev(page))

test.describe('US1 MVP 흐름', () => {
  test('#1 S1 — 개인정보 고지, 한도 표시 없음, 관점 사업자 고정', async ({ page }) => {
    await page.goto('/analyze')
    const privacy = page.locator('[data-part="privacy"]')
    await expect(privacy).toContainText('주민등록번호')
    await expect(privacy).toContainText('24시간')
    await expect(page.locator('[data-c="C10"]')).toHaveCount(0)
    await expect(page.getByText('로그인', { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-part="business-note"]')).toContainText('사업자')
    // C11 은 바로 분석할 수 있으면 숨긴다(2026-09-30 S1 줄이기) — 쉬는 중 · 연결 안 됨일 때만 보인다(단위 테스트 views.spec)
  })

  test('#2 표본 PDF 업로드 — 사전 검사 5항목 통과, 분석 시작 활성', async ({ page }) => {
    test.skip(!hasFixture('contracts/subscription-sample.pdf'), '표본 파일 없음(tests/fixtures/contracts)')
    await page.goto('/')
    await page.locator('[data-part="file-input"]').setInputFiles(fixture('contracts/subscription-sample.pdf'))
    for (const c of ['format', 'size', 'pages', 'encrypted', 'corrupt'])
      await expect(page.locator(`[data-check="${c}"]`)).toContainText('통과')
    await expect(startButton(page)).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('#3~#6 분석 시작 → S2 세부 줄 → 유형 확정 → S3 진행 → 결과 보기 → S4-B + 판정·근거·드로어', async ({ page }) => {
    const file = hasFixture('contracts/subscription-sample.pdf') ? fixture('contracts/subscription-sample.pdf') : undefined
    await runAnalysis(page, { file })

    // #5 S4-B: 고지 띠 + 기준일, 위험도별 개수, 하이라이트(글자+모양), 위험도순 목록, 분석 기록에 남음
    await expect(page.locator('[data-c="C4"]')).toContainText('법률 자문이 아닙니다')
    await expect(page.locator('[data-c="C4"]')).toContainText('지식 기준일')
    await expect(page.locator('[data-part="counts"]')).toContainText('위험도 높음')
    await expect(page.locator('[data-view="S4-B"]')).toBeVisible()
    await expect(page.locator('[data-part="risk-list"] li').first()).toBeVisible()
    const hl = page.locator('[data-part="source"] button.hl').first()
    await expect(hl).toHaveClass(/(^|\s)(high|mid|low)(\s|$)/) // 클래스 순서와 무관하게 위험도 모양 클래스
    await expect(hl).toHaveAttribute('aria-label', /위험도|분석 불가|가능/)
    const resultUrl = page.url()
    await page.goto('/history')
    await expect(page.locator('table.spec tbody tr').first()).toBeVisible()
    await page.goto(resultUrl)

    // #6 하이라이트 조항 선택 → C5 + 근거 칩 ≥1 → 드로어 6항목
    await selectFirstRiskClause(page)
    const verdict = page.locator('[data-panel="verdict"] [data-c="C5"]')
    await expect(verdict).toBeVisible()
    await expect(verdict.locator('.cat')).not.toBeEmpty()
    const chip = page.locator('[data-panel="verdict"] [data-c="C6"]').first()
    await expect(chip).toBeVisible()
    await chip.click()
    const drawer = page.locator('[data-c="D1"]')
    await expect(drawer).toBeVisible()
    for (const k of ['출처 유형', '출처명', '식별 정보', '원문 발췌', '출처 링크']) await expect(drawer.locator('dt', { hasText: k })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(chip).toBeFocused()
  })
})

test.describe('US1 게이트', () => {
  test('G2 — 60MB 파일: 사전 검사 실패 + C2, 분석 시작 비활성(사유 붙음)', async ({ page }, testInfo) => {
    await page.goto('/')
    // Playwright 는 50MB 넘는 버퍼를 직접 받지 않는다 — 임시 파일로 넘긴다
    const big = testInfo.outputPath('big-contract.pdf')
    writeFileSync(big, Buffer.alloc(60 * 1024 * 1024, 0x20))
    await page.locator('[data-part="file-input"]').setInputFiles(big)
    await expect(page.locator('[data-gate="G2"]')).toBeVisible()
    await expect(page.locator('[data-check="size"]')).toContainText('실패')
    await expect(startButton(page)).toHaveAttribute('aria-disabled', 'true')
    const describedBy = await startButton(page).getAttribute('aria-describedby')
    await expect(page.locator(`#${describedBy}`)).toContainText('G2')
  })

  test('G2 — 암호 PDF(표본이 있을 때)', async ({ page }) => {
    test.skip(!hasFixture('contracts/encrypted.pdf'), '암호 PDF 표본 없음')
    await page.goto('/')
    await page.locator('[data-part="file-input"]').setInputFiles(fixture('contracts/encrypted.pdf'))
    await expect(page.locator('[data-gate="G2"]')).toBeVisible()
    await expect(page.locator('[data-check="encrypted"]')).toContainText('실패')
  })

  test('이용 한도 없음 — 4번째 분석도 시작할 수 있다(E2E_NO_QUOTA=1)', async ({ page }) => {
    test.skip(!process.env.E2E_NO_QUOTA, '느린 경로 — 필요할 때만')
    for (let i = 0; i < 3; i++) await runAnalysis(page)
    await page.goto('/')
    await expect(page.locator('[data-gate="G4"]')).toHaveCount(0)
    await page.getByRole('tab', { name: '텍스트 붙여넣기' }).click()
    await page.locator('#text-input').fill('제1조(목적) 이 약관은 서비스 이용 조건을 정한다.')
    await expect(startButton(page)).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('G5 — 분석 서버 불가: "분석 일시 불가"', async ({ page }) => {
    // 스텁을 STUB_HEALTH=loading 으로 재기동한 환경(E2E_STUB_HEALTH=loading)이면 실제 응답을, 아니면 가로채서 재현한다
    if (process.env.E2E_STUB_HEALTH !== 'loading') {
      await page.route('**/api/analyses', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 503,
              json: { gate: 'G5', title: '분석 일시 불가', reason: '분석 서버가 모델을 불러오는 중입니다. 서버가 복구되면 다시 시도해 주세요', releaseActor: 'operator', releaseText: '운영자 - 서버 복구', nextActions: [{ id: 'recheck_status', label: '상태 다시 확인' }] },
            })
          : route.continue(),
      )
    }
    await page.goto('/')
    await page.getByRole('tab', { name: '텍스트 붙여넣기' }).click()
    await page.locator('#text-input').fill('제1조(목적) 이 약관은 …')
    await startButton(page).click()
    const gate = page.locator('[data-gate="G5"]')
    await expect(gate).toContainText('분석 일시 불가')
    await expect(page.locator('.step.block')).toContainText('차단 G5')
  })

  test('G6 — 계약서가 아닌 문서(표본이 있을 때)', async ({ page }) => {
    test.skip(!hasFixture('non-contract/receipt.pdf'), '비계약 표본 없음')
    await page.goto('/')
    await page.locator('[data-part="file-input"]').setInputFiles(fixture('non-contract/receipt.pdf'))
    await startButton(page).click()
    await page.waitForURL(/structuring/)
    await expect(page.locator('[data-gate="G6"]')).toContainText('계약서·약관으로 인식되지 않았습니다', { timeout: 120_000 })
  })

  test('G8 — 다른 계정으로 결과 URL 직접 열기: 화면 전체 대체 C2', async ({ page, browser }) => {
    const url = await runAnalysis(page)
    const other = await browser.newContext()
    const p2 = await other.newPage()
    await loginDev(p2)
    await p2.goto(url)
    const gate = p2.locator('[data-gate="G8"]')
    await expect(gate).toBeVisible()
    await expect(gate).toHaveClass(/full/)
    await expect(gate).toHaveAttribute('role', 'alert')
    await expect(p2.locator('[data-part="source"]')).toHaveCount(0)
    await other.close()
  })

  test('분석 취소 — 확인 문구 후 취소 안내', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: '텍스트 붙여넣기' }).click()
    await page.locator('#text-input').fill('제1조(목적) 이 약관은 …\n제2조(해지) 회사는 언제든 해지할 수 있다.')
    await startButton(page).click()
    await page.waitForURL(/structuring/)
    const cancel = page.locator('[data-action="cancel-analysis"]')
    test.skip(!(await cancel.isVisible()), '이미 취소 불가 단계')
    await cancel.click()
    await expect(page.locator('[data-part="cancel-notice"]')).toHaveText('진행 중인 처리를 멈춥니다. 다시 분석하려면 새 분석을 시작하세요')
    await page.locator('.dialog [data-action="confirm"]').click()
    await expect(page.locator('[data-part="cancelled"]')).toContainText('분석을 취소했습니다')
  })
})
