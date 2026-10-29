// T145 — 스타일 규칙 점검(jsdom 은 레이아웃을 계산하지 않으므로 CSS 원문으로 확인한다)
// 360px(≤640)·768px(≤768)·1280px(기본) 레이아웃 분기와 가이드 금지 규칙.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = resolve(__dirname, '../../src/styles')
const tokens = readFileSync(resolve(dir, 'tokens.css'), 'utf8')
const comps = readFileSync(resolve(dir, 'components.css'), 'utf8')
const all = tokens + comps

describe('compact 토큰(2026-10-01, cosmos.so 참조) — 골격은 Harvey 스타일 가이드', () => {
  it(':root 토큰과 .t-* 타이포 클래스', () => {
    for (const t of ['--color-primary:#111111', '--color-ink:#111111', '--color-canvas:#ffffff', '--color-paper:#f6f6f7', '--color-focus-ring', '--color-danger:', '--color-success:', '--rounded-full:9999px', '--rounded-sm:8px', '--rounded-lg:16px', '--rounded-xl:20px', '--spacing-section:80px', '--header-height:64px'])
      expect(tokens).toContain(t)
    for (const c of ['.t-hero', '.heading-2', '.t-display-xl', '.t-heading-lg', '.t-body-md', '.t-caption-sm', '.t-code-sm', '.t-button-md']) expect(tokens).toContain(c)
  })
  it('섹션 간격 80 → 64(≤768) → 48(≤640)', () => {
    expect(tokens).toMatch(/@media \(max-width:768px\)\{\s*:root\{--spacing-section:64px;--header-height:64px\}/)
    expect(tokens).toMatch(/@media \(max-width:640px\)\{\s*:root\{--spacing-section:48px\}/)
  })
  it('브레이크포인트 850/768/640 — 햄버거 항상(메뉴 창은 오른쪽에서) + 좁은 화면은 가로 메뉴 숨김(≤768), 비교 보기 상하(≤768), 결과 1열(≤850)', () => {
    expect(comps).toMatch(/@media \(max-width:850px\)\{[^@]*\.result-grid\{grid-template-columns:1fr\}/)
    expect(comps).toMatch(/@media \(max-width:768px\)\{[^@]*\.primary-nav \.right \.burger\{display:inline-flex\}/)
    expect(comps).toMatch(/@media \(max-width:768px\)\{[^@]*\.compare\{grid-template-columns:1fr\}/)
    expect(comps).toMatch(/@media \(max-width:640px\)\{[^@]*\.gate dl,\.kv\{grid-template-columns:1fr/)
  })
  it('서비스 컴포넌트 클래스가 모두 있다', () => {
    for (const c of ['.rail', '.step.done', '.step.now', '.step.block', '.gate-head', '.gate-id', '.reasoned', '.reason', '.band', '.change-band', '.verdict', '.cat', '.risk.high', '.risk.mid', '.risk.low', '.aux', '.hl.high', '.hl.mid', '.hl.low', '.chip.lit', '.chip.changed', '.scrim', '.drawer', '.fallback', '.mask', '.quota', '.pips', '.status.ready', '.status.loading', '.status.down', '.status.key', '.status.cold', '.terminal-card', 'table.spec', '.faq-row', '.primary-nav', '.footer-section', '.search-pill', '.command-tag', '.text-input', '.burger', '.menu-panel', '.menu-panel.open', '.menu-scrim', '.menu-group', '.hero', '.src-btn', '.composer', '.dropzone', '.api-status', '.rules', '.ep', '.code-card'])
      expect(all).toContain(c)
  })
  it('그림자는 포커스 링만(none 허용), 그라디언트는 .status.loading 반채움과 배경 구름(body::before)만', () => {
    const shadows = all.match(/box-shadow:[^;}]+/g) ?? []
    for (const s of shadows) expect(s).toMatch(/var\(--color-focus-ring\)|^box-shadow:none$/)
    const grads = all.match(/[^\n]*gradient[^\n]*/g) ?? []
    expect(grads).toHaveLength(2)
    expect(grads.some((g) => g.includes('.status.loading'))).toBe(true)
    expect(grads.some((g) => g.startsWith('body::before{'))).toBe(true)
  })
  it('compact 층: 알약 버튼 40px · 밝은 첫 화면 · 반응형 앞에 위치 · 다른 테마 값이 섞이지 않음', () => {
    const at = comps.indexOf('SITE LAYER — compact')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(comps.indexOf('RESPONSIVE — 850'))
    expect(comps).toContain('.btn{height:40px;padding:0 16px;border-width:1px;border-radius:var(--rounded-full)')
    expect(comps).toContain('.risk.high{background:var(--color-risk-high)')
    expect(comps).toMatch(/\.hero\{--color-on-dark:var\(--color-ink\);--color-on-dark-mute:var\(--color-body\);[^}]*background:transparent/)
    for (const old of ['dropbox', 'SITE LAYER — dropbox.com', 'font-stretch', '#0061fe', '#b4dc19', '#428bff', 'Archivo']) expect(all.replace(/\/\*[\s\S]*?\*\//g, ''), old).not.toContain(old)
  })
  it('스킵 링크는 포커스하면 보이고, 첫 화면은 제목·입력 방식 왼쪽 · 안내 오른쪽', () => {
    expect(comps).toContain('a.visually-hidden:focus{position:fixed!important')
    expect(comps).toContain('.hero-side{grid-column:1 / span 6;grid-row:2;align-self:start}')
    expect(comps).toContain('.hero .charcoal,.hero .muted')
    const s1 = readFileSync(resolve(__dirname, '../../src/views/S1Intake.vue'), 'utf8')
    expect(s1).toMatch(/type="file" class="visually-hidden" tabindex="-1"/)
  })
  it('위험도는 기호(●◐○)를 함께 쓴다', () => {
    expect(comps).toContain('.risk.high::before{content:"●"}')
    expect(comps).toContain('.risk.mid::before{content:"◐"}')
    expect(comps).toContain('.risk.low::before{content:"○"}')
  })
  it('CSS 파일에 HTML 태그가 섞이지 않는다(<style> 이 들어가면 :root 토큰 전체가 무효)', () => {
    for (const css of [tokens, comps]) expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/<\/?style/)
  })
  it('Vue 템플릿에 인라인 style 을 쓰지 않는다(간격은 spacing 토큰 유틸리티로)', () => {
    const vues = (readdirSync(resolve(__dirname, '../../src'), { recursive: true }) as string[]).filter((f) => f.endsWith('.vue'))
    expect(vues.length).toBeGreaterThan(0)
    for (const f of vues) expect(readFileSync(resolve(__dirname, '../../src', f), 'utf8'), f).not.toMatch(/\sstyle="/)
  })
  it('배경 모션은 transform 만 움직이고, 모션 줄이기면 멈춘다', () => {
    expect(comps).toMatch(/@keyframes bg-drift\{[^@]*transform:translate3d/)
    expect(comps).not.toMatch(/@keyframes bg-drift\{[^}]*(background|opacity|filter)/)
    expect(comps).toContain('@media (prefers-reduced-motion:reduce){body::before{animation:none}}')
  })
  it('글꼴은 Pretendard 하나 — index.html 은 Google Fonts 를 부르지 않는다', () => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')
    expect(html).toContain('pretendard')
    expect(html).not.toContain('fonts.googleapis.com')
    expect(tokens).toMatch(/--font-display:"Pretendard Variable"/)
    expect(tokens).toMatch(/--font-sans:"Pretendard Variable"/)
  })
})
