// T145 — 화면 수준 점검: S1 비용 순서 게이트(G5)와 C11 콜드 스타트, 사업자 관점 고정, 로그인·역할(RBAC) 앱 셸
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

const apiMock = vi.hoisted(() => ({
  modelServerStatus: vi.fn(),
  privacyNotice: vi.fn(),
  upload: vi.fn(),
  createAnalysis: vi.fn(),
  session: vi.fn(),
  logout: vi.fn(),
  login: vi.fn(),
  signup: vi.fn(),
  apiKeys: vi.fn(),
  issueApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  adminApiKeys: vi.fn(),
  adminRevokeApiKey: vi.fn(),
  modelApiStatus: vi.fn(),
  modelApiDoc: vi.fn(),
  modelApiOpenapiUrl: vi.fn(() => '/api/admin/model-api/openapi'),
}))
vi.mock('@/api/endpoints', () => ({ api: apiMock }))

import S1Intake from '@/views/S1Intake.vue'
import App from '@/App.vue'
import { makeRouter as makeGuardedRouter, routes } from '@/router'

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes })
}

beforeEach(() => {
  setActivePinia(createPinia())
  Object.values(apiMock).forEach((f) => 'mockReset' in f && f.mockReset())
  apiMock.privacyNotice.mockResolvedValue({})
})

async function mountS1() {
  const router = makeRouter()
  await router.push('/')
  const w = mount(S1Intake, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}

describe('S1 분석 접수', () => {
  it('개인정보 고지(FR-010 전 항목)가 입력 영역보다 먼저, 항상 보인다', async () => {
    apiMock.modelServerStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-30T01:00:00Z', coldStart: false })
    const w = await mountS1()
    const privacy = w.find('[data-part="privacy"]')
    expect(privacy.exists()).toBe(true)
    const t = privacy.text()
    for (const k of ['주민등록번호', '외국인등록번호', '계좌번호', '카드번호', '전화번호', '이메일', '주소', '이름', '24시간', '내 계정의 분석 기록', '삭제', '의견']) expect(t).toContain(k)
    expect(t).not.toContain('비로그인')
    const html = w.html()
    expect(html.indexOf('data-part="privacy"')).toBeLessThan(html.indexOf('role="tablist"'))
    w.unmount()
  })

  it('이용 한도 표시(C10)·G4 차단이 없다', async () => {
    apiMock.modelServerStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-30T01:00:00Z' })
    const w = await mountS1()
    expect(w.find('[data-c="C10"]').exists()).toBe(false)
    expect(w.find('[data-c="C11"]').exists()).toBe(false) // 바로 분석할 수 있으면 서버 상태를 숨긴다
    expect(w.find('[data-part="sample"]').exists()).toBe(false) // 예시 문서 칸 없음 — 예시 카드로 넣는다
    expect(w.find('#tab-url .lbl-long').text()).toBe('웹페이지 주소(URL)') // 휴대폰에서는 짧은 이름만 보인다(한 줄 탭)
    expect(w.find('#tab-url .lbl-short').text()).toBe('웹 주소')
    expect(w.find('[data-gate="G4"]').exists()).toBe(false)
    expect(w.text()).not.toContain('무료 분석')
    w.unmount()
  })

  it('서버 연결 불가면 G5 로 비활성, 콜드 스타트면 시작 가능 + 준비 시간 안내', async () => {
    apiMock.modelServerStatus.mockResolvedValue({ state: 'unreachable', checkedAt: '2026-09-30T01:00:00Z' })
    const w = await mountS1()
    await w.find('#tab-text').trigger('click')
    await w.find('#text-input').setValue('제1조 목적 이 약관은 …')
    let start = w.findAll('[data-c="C3"] button').find((b) => b.text() === '분석 시작')!
    expect(start.attributes('aria-disabled')).toBe('true')
    expect(w.find(`#${start.attributes('aria-describedby')}`).text()).toBe('지금은 분석할 수 없어요')
    expect(w.find('[data-c="C11"] [data-action="refresh"]').exists()).toBe(true) // 연결 안 됨은 다시 확인 버튼까지
    w.unmount()

    apiMock.modelServerStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-30T01:00:00Z', coldStart: true, warmupEstimateSec: 30 })
    const w2 = await mountS1()
    await w2.find('#tab-text').trigger('click')
    await w2.find('#text-input').setValue('제1조 목적 이 약관은 …')
    start = w2.findAll('[data-c="C3"] button').find((b) => b.text() === '분석 시작')!
    expect(start.attributes('aria-disabled')).toBeUndefined()
    expect(start.classes()).toContain('btn-primary')
    expect(w2.find('[data-c="C11"]').text()).toContain('잠시 쉬는 중')
    expect(w2.find('[data-c="C11"]').text()).toContain('약 30초')
    expect(w2.find('[data-c="C11"] [data-action="refresh"]').exists()).toBe(false) // 쉬는 중은 한 줄만(2026-09-30 S1 줄이기)
    // 채운 검정 버튼은 하나뿐
    expect(w2.findAll('.btn-primary')).toHaveLength(1)
    w2.unmount()
  })

  it('50MB 초과 파일은 올리지 않고 G2 로 막는다', async () => {
    apiMock.modelServerStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-30T01:00:00Z' })
    const w = await mountS1()
    const input = w.find('[data-part="file-input"]')
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: 62 * 1024 * 1024 })
    Object.defineProperty(input.element, 'files', { value: [big] })
    await input.trigger('change')
    await flushPromises()
    expect(apiMock.upload).not.toHaveBeenCalled()
    expect(w.find('[data-gate="G2"]').exists()).toBe(true)
    expect(w.find('[data-check="size"]').text()).toContain('맞지 않아요')
    w.unmount()
  })

  it('관점은 사업자로 고정 — 선택 조작 없이 안내만, 분석 요청도 business', async () => {
    apiMock.modelServerStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-30T01:00:00Z' })
    apiMock.createAnalysis.mockResolvedValue({ requestId: 7, knowledgeDate: '2026-09-15' })
    const w = await mountS1()
    expect(w.find('input[name="persp"]').exists()).toBe(false)
    expect(w.find('[data-part="business-note"]').text()).toContain('사업자')
    await w.find('#tab-text').trigger('click')
    await w.find('#text-input').setValue('제1조 목적 이 약관은 서비스 이용 조건을 정한다')
    await w.findAll('[data-c="C3"] button').find((b) => b.text() === '분석 시작')!.trigger('click')
    await flushPromises()
    expect(apiMock.createAnalysis).toHaveBeenCalledWith('business', expect.objectContaining({ kind: 'text' }))
    w.unmount()
  })
})

const ROLE_PERMS = {
  user: ['analysis.request', 'result.view', 'explanation.view', 'history.manage', 'feedback.submit', 'modelApi.view'],
  operator: ['knowledge.manage', 'eval.run', 'eval.review', 'feedback.review', 'modelApi.view', 'modelApi.manage'],
  legal_expert: ['eval.review'],
  developer: ['modelApi.view', 'modelApi.manage'],
} as const
const NAMES = { user: '홍길동', operator: '김운영', legal_expert: '이전문', developer: '박개발' } as const
function sessionAs(role: keyof typeof ROLE_PERMS | null) {
  apiMock.session.mockResolvedValue(
    role
      ? { loggedIn: true, user: { userId: 1, role, provider: 'local', nickname: NAMES[role] }, permissions: [...ROLE_PERMS[role]], authProviders: [] }
      : { loggedIn: false, user: null, permissions: [], authProviders: [] },
  )
}
async function mountShell(path: string) {
  const router = makeGuardedRouter(createMemoryHistory())
  await router.push(path)
  const w = mount(App, { global: { plugins: [router], stubs: { RouterView: true } } })
  await flushPromises()
  const menu = (label: string) => w.findAll(`.primary-nav [aria-label="${label}"] a`).map((a) => a.text())
  return { w, router, menu }
}

describe('앱 셸 — 로그인·역할(RBAC)', () => {
  it('비로그인은 로그인 화면으로 보내고 메뉴가 없다', async () => {
    sessionAs(null)
    const { w, router, menu } = await mountShell('/history')
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.returnTo).toBe('/history')
    expect(menu('사용자 메뉴')).toEqual([])
    expect(menu('운영 메뉴')).toEqual([])
    w.unmount()
  })

  it('운영자로 로그인하면 사이트 글자를 한 단계 굵게(html.role-operator), 앱이 내려가면 지운다(2026-09-30)', async () => {
    sessionAs('operator')
    const { w } = await mountShell('/')
    expect(document.documentElement.classList.contains('role-operator')).toBe(true)
    w.unmount()
    expect(document.documentElement.classList.contains('role-operator')).toBe(false)
  })

  it('메뉴 창 API 항목 — 같은 주소(/api-guide)여도 지금 탭 하나만 현재 메뉴(2026-09-30)', async () => {
    sessionAs('user')
    const { w, router } = await mountShell('/api-guide?tab=keys')
    const current = () => w.findAll('[data-part="menu-panel"] [data-api-tab][aria-current="page"]').map((a) => a.attributes('data-api-tab'))
    expect(current()).toEqual(['keys'])
    await router.push('/api-guide')
    await flushPromises()
    expect(current()).toEqual(['endpoints']) // tab 이 없으면 첫 탭
    await router.push('/history')
    await flushPromises()
    expect(current()).toEqual([])
    w.unmount()
  })

  it('메뉴 창 로그인 · 회원가입 — 같은 주소(/login)여도 ?mode= 에 맞는 하나만 현재 메뉴(2026-10-01)', async () => {
    sessionAs(null)
    const { w, router } = await mountShell('/login')
    const current = () => w.findAll('[data-part="menu-panel"] [data-login-mode][aria-current="page"]').map((a) => a.attributes('data-login-mode'))
    expect(current()).toEqual(['login'])
    await router.push('/login?mode=signup')
    await flushPromises()
    expect(current()).toEqual(['signup'])
    w.unmount()
  })

  it('사용자는 굵게 하지 않는다', async () => {
    sessionAs('user')
    const { w } = await mountShell('/')
    expect(document.documentElement.classList.contains('role-operator')).toBe(false)
    w.unmount()
  })

  it('사용자 — 사용자 메뉴만, 머리글은 가입 이름, 운영 화면은 권한 없음(G14)', async () => {
    sessionAs('user')
    const { w, router, menu } = await mountShell('/')
    expect(router.currentRoute.value.name).toBe('intake')
    expect(menu('사용자 메뉴')).toEqual(['새 분석', '분석 기록'])
    expect(menu('운영 메뉴')).toEqual([])
    expect(w.find('[data-testid="who"]').text()).toBe('홍길동')
    expect(w.find('[data-part="brand-mark"]').exists()).toBe(true)
    await router.push('/admin/knowledge')
    expect(router.currentRoute.value.name).toBe('forbidden')
    await router.push('/api-guide')
    expect(router.currentRoute.value.name).toBe('model-api')
    w.unmount()
  })

  it('운영자 — 운영 메뉴 4개(권한 관리 없음), 첫 화면은 근거 자료, 사용자 영역은 권한 없음', async () => {
    sessionAs('operator')
    const { w, router, menu } = await mountShell('/')
    expect(router.currentRoute.value.path).toBe('/admin/knowledge')
    expect(menu('사용자 메뉴')).toEqual([])
    expect(menu('운영 메뉴')).toEqual(['근거 자료 관리', '품질 점검', '전문가 검토', '이용자 의견 검토'])
    expect(w.find('[data-testid="who"]').text()).toBe('김운영운영자')
    await router.push('/history')
    expect(router.currentRoute.value.name).toBe('forbidden')
    await router.push('/admin/rbac')
    expect(router.currentRoute.value.name).toBe('not-found')
    w.unmount()
  })

  it('법률 전문가 — 전문가 검토만, 개발자 — API 활용만', async () => {
    sessionAs('legal_expert')
    let s = await mountShell('/')
    expect(s.router.currentRoute.value.path).toBe('/admin/eval/expert')
    expect(s.menu('운영 메뉴')).toEqual(['전문가 검토'])
    await s.router.push('/admin/eval')
    expect(s.router.currentRoute.value.name).toBe('forbidden')
    s.w.unmount()

    setActivePinia(createPinia())
    sessionAs('developer')
    apiMock.modelApiStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-29T07:00:00Z', models: [] })
    s = await mountShell('/')
    expect(s.router.currentRoute.value.path).toBe('/api-guide')
    s.w.unmount()
  })
})

describe('햄버거 메뉴 — 오른쪽에서 밀려 나오는 메뉴 창', () => {
  const groups = (w: ReturnType<typeof mount>) => w.findAll('[data-part="menu-panel"] .menu-group h2').map((h) => h.text())

  it('비로그인: 두 줄 아이콘으로 열고 닫는다. 로그인 · 회원가입 링크만', async () => {
    sessionAs(null)
    const { w } = await mountShell('/login')
    const burger = w.find('[data-part="burger"]')
    expect(burger.findAll('path')).toHaveLength(2)
    expect(w.find('[data-part="menu-panel"]').classes()).not.toContain('open')
    await burger.trigger('click')
    expect(burger.attributes('aria-expanded')).toBe('true')
    expect(w.find('[data-part="menu-panel"]').classes()).toContain('open')
    expect(w.find('[data-part="menu-scrim"]').classes()).toContain('open')
    expect(groups(w)).toEqual(['계정'])
    const links = w.findAll('[data-group="account"] a').map((a) => a.attributes('href'))
    expect(links).toEqual(['/login', '/login?mode=signup'])

    await w.find('[data-part="menu-scrim"]').trigger('click')
    expect(w.find('[data-part="menu-panel"]').classes()).not.toContain('open')
    w.unmount()
  })

  it('사용자: 분석하기 · API 활용(운영 탭 없음) · 계정', async () => {
    sessionAs('user')
    const { w } = await mountShell('/')
    await w.find('[data-part="burger"]').trigger('click')
    expect(groups(w)).toEqual(['분석', 'API 활용', '계정'])
    expect(w.find('[data-part="menu-account"]').text()).toContain('홍길동')
    const api = w.findAll('[data-group="api"] a').map((a) => a.attributes('href'))
    expect(api).toEqual(['/api-guide?tab=endpoints', '/api-guide?tab=quickstart', '/api-guide?tab=keys', '/api-guide?tab=guidelines'])
    w.unmount()
  })

  it('운영자: 운영이 먼저, API 활용에 운영 탭까지, 분석하기는 없다', async () => {
    sessionAs('operator')
    const { w } = await mountShell('/')
    await w.find('[data-part="burger"]').trigger('click')
    expect(groups(w)).toEqual(['운영', 'API 활용', '계정'])
    const api = w.findAll('[data-group="api"] a').map((a) => a.attributes('href'))
    expect(api).toContain('/api-guide?tab=status')
    expect(api).toContain('/api-guide?tab=docs')
    w.unmount()
  })
})

describe('S9 API 활용', () => {
  async function mountS9(role: 'user' | 'operator', path: string) {
    sessionAs(role)
    apiMock.modelApiStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-29T07:00:00Z', models: [] })
    apiMock.modelServerStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-29T07:00:00Z' })
    apiMock.apiKeys.mockResolvedValue({ items: [] })
    apiMock.adminApiKeys.mockResolvedValue({ items: [] })
    const { useSessionStore } = await import('@/stores/session')
    await useSessionStore().load()
    const { default: S9 } = await import('@/views/S9ApiGuide.vue')
    const router = makeRouter()
    await router.push(path)
    const w = mount(S9, { global: { plugins: [router] } })
    await flushPromises()
    return { w, router }
  }

  it('사용자: 운영 탭 없이 4개, 문구 · 버튼 모양, 예시는 발급 키 자리', async () => {
    const { w, router } = await mountS9('user', '/api-guide?tab=quickstart')
    expect(w.find('[data-part="status-line"]').text()).toContain('정상')
    expect(apiMock.modelApiStatus).not.toHaveBeenCalled()
    expect(w.findAll('[role="tab"][data-tab]').map((t) => t.text())).toEqual(['기능 목록', '처음 써 보기', 'API 키', '이용 규칙'])
    expect(w.text()).not.toContain('운영자 · 개발자 전용')
    expect(w.text()).not.toContain('편법 · 위법 탐지, 최종 판정, 계약 요약')
    expect(w.find('[data-part="openapi-link"]').classes()).toEqual(w.find('[data-part="swagger-link"]').classes())
    const code = w.find('[data-part="quickstart-code"] pre').text()
    expect(code).toContain('<발급받은 API 키>')
    expect(code).toContain('/api/model/v1/detect/loophole')
    expect(code).not.toContain('MODEL_API_KEY')
    await w.find('[data-tab="endpoints"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('endpoints')
    expect(w.findAll('[data-part="errors"] tbody tr').length).toBeGreaterThanOrEqual(6)
    w.unmount()
  })

  it('API 키: 발급하면 원문을 한 번 보여 주고 목록을 다시 읽는다', async () => {
    const { w } = await mountS9('user', '/api-guide?tab=keys')
    apiMock.issueApiKey.mockResolvedValue({ keyId: 3, name: '테스트', keyPrefix: 'crd_abcdefgh', key: 'crd_abcdefghSECRET', createdAt: '2026-09-30T00:00:00Z', lastUsedAt: null, revokedAt: null })
    apiMock.apiKeys.mockResolvedValue({ items: [{ keyId: 3, name: '테스트', keyPrefix: 'crd_abcdefgh', createdAt: '2026-09-30T00:00:00Z', lastUsedAt: null, revokedAt: null }] })
    await w.find('[data-part="key-name"]').setValue('테스트')
    await w.find('[data-action="issue-key"]').trigger('submit')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(apiMock.issueApiKey).toHaveBeenCalledWith('테스트')
    expect(w.find('[data-part="issued-key"]').text()).toContain('crd_abcdefghSECRET')
    expect(w.find('[data-part="my-keys"]').text()).toContain('crd_abcdefgh…')
    expect(w.find('[data-part="all-keys"]').exists()).toBe(false)
    w.unmount()
  })

  it('운영자: 운영 탭까지 7개, 상세 상태 API 를 쓴다', async () => {
    const { w } = await mountS9('operator', '/api-guide?tab=status')
    expect(apiMock.modelApiStatus).toHaveBeenCalled()
    expect(w.findAll('[role="tab"][data-tab]').map((t) => t.text())).toEqual(['기능 목록', '처음 써 보기', 'API 키', '이용 규칙', '운영 매뉴얼', '서버 상태', '문서 · 점검 결과'])
    w.unmount()
  })
})

describe('로그인 · 회원가입', () => {
  it('아이디 · 비밀번호로 로그인하고 역할의 첫 화면으로 간다', async () => {
    sessionAs(null)
    const { default: Login } = await import('@/views/LoginView.vue')
    const router = makeGuardedRouter(createMemoryHistory())
    await router.push('/login')
    const w = mount(Login, { global: { plugins: [router] } })
    await flushPromises()
    expect(w.find('[data-provider]').exists()).toBe(false)
    apiMock.login.mockResolvedValue({ ok: true, returnTo: '/' })
    await w.find('#login-id').setValue('user1')
    await w.find('#login-password').setValue('User1234!')
    sessionAs('user')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(apiMock.login).toHaveBeenCalledWith('user1', 'User1234!', '/')
    expect(router.currentRoute.value.path).toBe('/')
    w.unmount()
  })

  it('회원가입은 이름 · 비밀번호 확인을 받는다. 틀린 입력은 칸마다 알리고, 틀린 로그인은 해요체 문구(2026-09-30)', async () => {
    sessionAs(null)
    const { default: Login } = await import('@/views/LoginView.vue')
    const { ApiError } = await import('@/api/client')
    const router = makeGuardedRouter(createMemoryHistory())
    await router.push('/login?mode=signup')
    const w = mount(Login, { global: { plugins: [router] } })
    await flushPromises()
    expect(w.find('#signup-name').exists()).toBe(true)
    expect(w.find('#signup-password2').exists()).toBe(true)
    await w.find('#login-id').setValue('newbie')
    await w.find('#signup-name').setValue('새사람')
    await w.find('#login-password').setValue('abcd1234')
    await w.find('#signup-password2').setValue('abcd9999')
    expect(w.find('[data-action="submit"]').attributes('disabled')).toBeUndefined() // 막지 않고 누르면 이유를 알린다
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(apiMock.signup).not.toHaveBeenCalled()
    expect(w.find('[data-part="error-pw2"]').text()).toContain('위에 넣은 비밀번호와 달라요')
    expect(w.find('#signup-password2').attributes('aria-invalid')).toBe('true')
    expect(w.find('#signup-password2').attributes('aria-describedby')).toContain('signup-password2-error')
    await w.find('#signup-password2').setValue('abcd1234')
    apiMock.signup.mockResolvedValue({ ok: true, returnTo: '/' })
    sessionAs('user')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(apiMock.signup).toHaveBeenCalledWith('newbie', 'abcd1234', '새사람', '/')
    w.unmount()

    setActivePinia(createPinia())
    sessionAs(null)
    await router.push('/login')
    const w2 = mount(Login, { global: { plugins: [router] } })
    await flushPromises()
    apiMock.login.mockRejectedValue(new ApiError(401, { code: 'login_failed', message: '아이디 또는 비밀번호가 맞지 않습니다' }))
    await w2.find('#login-id').setValue('x1234')
    await w2.find('#login-password').setValue('wrong')
    await w2.find('form').trigger('submit')
    await flushPromises()
    expect(w2.find('[data-part="login-error"]').text()).toBe('아이디나 비밀번호가 맞지 않아요. 다시 확인해 주세요. 계정이 없다면 회원가입을 해 주세요')
    w2.unmount()
  })

  it('회원가입 칸 검사 — 규칙에 안 맞는 아이디 · 짧은 비밀번호는 칸마다 알리고 첫 칸으로 초점, 이미 쓰는 아이디는 아이디 칸에', async () => {
    sessionAs(null)
    const { default: Login } = await import('@/views/LoginView.vue')
    const { ApiError } = await import('@/api/client')
    const router = makeGuardedRouter(createMemoryHistory())
    await router.push('/login?mode=signup')
    const w = mount(Login, { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    await w.find('#login-id').setValue('A')
    await w.find('#signup-name').setValue('x')
    await w.find('#login-password').setValue('short')
    await w.find('#signup-password2').setValue('short')
    expect(w.find('[data-part="error-id"]').exists()).toBe(false) // 입력 중에는 먼저 띄우지 않는다
    await w.find('form').trigger('submit')
    await flushPromises()
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    expect(w.find('[data-part="error-id"]').text()).toContain('영문 소문자나 숫자로 시작하는 4~32자')
    expect(w.find('[data-part="error-pw"]').text()).toContain('8자 이상')
    expect(document.activeElement?.id).toBe('login-id')
    expect(apiMock.signup).not.toHaveBeenCalled()
    await w.find('#login-id').setValue('taken1')
    await w.find('#login-password').setValue('abcd1234')
    await w.find('#signup-password2').setValue('abcd1234')
    apiMock.signup.mockRejectedValueOnce(new ApiError(409, { code: 'login_id_taken', message: '이미 쓰고 있는 아이디입니다. 다른 아이디를 정해 주세요' }))
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[data-part="error-id"]').text()).toBe('이미 쓰고 있는 아이디예요. 다른 아이디를 정해 주세요')
    expect(w.find('#login-id').attributes('aria-invalid')).toBe('true')
    w.unmount()
  })
})
