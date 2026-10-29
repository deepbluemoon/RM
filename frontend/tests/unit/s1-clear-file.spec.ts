// S1 파일 놓는 곳 오른쪽 위 X — 선택한 파일 지우기(2026-09-30)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

const apiMock = vi.hoisted(() => ({ modelServerStatus: vi.fn(), privacyNotice: vi.fn(), upload: vi.fn(), createAnalysis: vi.fn() }))
vi.mock('@/api/endpoints', () => ({ api: apiMock }))
import S1Intake from '@/views/S1Intake.vue'
import { routes } from '@/router'

const OK = { uploadToken: 't1', pages: 12, checks: ['format', 'size', 'pages', 'encrypted', 'corrupt'].map((c) => ({ check: c, passed: true })) }

beforeEach(() => {
  setActivePinia(createPinia())
  Object.values(apiMock).forEach((f) => f.mockReset())
  apiMock.privacyNotice.mockResolvedValue({})
  apiMock.modelServerStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-09-30T01:00:00Z' })
})

async function mountS1() {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/')
  const w = mount(S1Intake, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}
async function choose(w: Awaited<ReturnType<typeof mountS1>>, f: File) {
  const input = w.find('[data-part="file-input"]')
  Object.defineProperty(input.element, 'files', { configurable: true, value: [f] })
  await input.trigger('change')
  await flushPromises()
}
const docx = () => new File(['docx'], '이용약관 예시.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })

describe('S1 선택한 파일 지우기(X)', () => {
  it('파일이 없으면 X 가 없다', async () => {
    const w = await mountS1()
    expect(w.find('[data-action="clear-file"]').exists()).toBe(false)
    w.unmount()
  })

  it('X 를 누르면 고르기 전 상태로 돌아가고 포커스는 파일 놓는 곳으로 간다', async () => {
    apiMock.upload.mockResolvedValue(OK)
    const w = await mountS1()
    await choose(w, docx())
    expect(w.find('[data-part="file-meta"]').text()).toContain('이용약관 예시.docx')
    const x = w.find('[data-action="clear-file"]')
    expect(x.attributes('aria-label')).toBe('선택한 파일 지우기')
    expect(x.element.closest('[data-part="dropzone"]')).toBeNull() // 버튼 안의 버튼이 아니다
    await x.trigger('click')
    await flushPromises()
    expect(w.find('[data-part="file-meta"]').exists()).toBe(false)
    expect(w.find('[data-part="dropzone"] strong').text()).toBe('파일을 여기에 끌어다 놓거나, 눌러서 골라 주세요')
    expect(w.find('[data-part="checks"]').exists()).toBe(false) // 파일 확인 목록은 파일을 고른 뒤에만
    expect(w.find('[data-action="clear-file"]').exists()).toBe(false)
    expect(document.activeElement).toBe(w.find('[data-part="dropzone"]').element)
    expect((w.find('[data-part="file-input"]').element as HTMLInputElement).value).toBe('')
    expect(apiMock.upload).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('사전 검사 중에는 X 를 숨긴다(늦은 검사 결과가 지운 파일에 붙지 않게)', async () => {
    let resolve!: (v: typeof OK) => void
    apiMock.upload.mockReturnValue(new Promise((r) => { resolve = r }))
    const w = await mountS1()
    await choose(w, docx())
    expect(w.find('[data-action="clear-file"]').exists()).toBe(false)
    resolve(OK)
    await flushPromises()
    expect(w.find('[data-action="clear-file"]').exists()).toBe(true)
    w.unmount()
  })

  it('50MB 초과로 막힌(G2) 파일도 X 로 지우면 차단 안내가 사라진다', async () => {
    const w = await mountS1()
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: 62 * 1024 * 1024 })
    await choose(w, big)
    expect(w.find('[data-gate="G2"]').exists()).toBe(true)
    await w.find('[data-action="clear-file"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-gate="G2"]').exists()).toBe(false)
    expect(w.find('[data-part="checks"]').exists()).toBe(false)
    w.unmount()
  })

  it('지운 뒤 같은 파일을 다시 고르면 다시 올린다', async () => {
    apiMock.upload.mockResolvedValue(OK)
    const w = await mountS1()
    const f = docx()
    await choose(w, f)
    await w.find('[data-action="clear-file"]').trigger('click')
    await choose(w, f)
    expect(apiMock.upload).toHaveBeenCalledTimes(2)
    expect(w.find('[data-part="file-meta"]').exists()).toBe(true)
    w.unmount()
  })

  it('파일 놓는 곳의 접근 이름 = 보이는 글(고르기 전 안내 문장 → 고른 뒤 파일 이름, 2026-10-01 WCAG 2.5.3)', async () => {
    apiMock.upload.mockResolvedValue(OK)
    const w = await mountS1()
    const zone = w.find('[data-part="dropzone"]')
    expect(zone.attributes('aria-label')).toBeUndefined()
    const label = () => document.getElementById(zone.attributes('aria-labelledby')!)!.textContent
    expect(label()).toBe('파일을 여기에 끌어다 놓거나, 눌러서 골라 주세요')
    // 설명 = 확인 상태 + 안내(여러 id). 고르기 전엔 상태 칸이 없고 안내(형식)만
    const desc = () => zone.attributes('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    expect(desc()).toContain('PDF')
    await choose(w, docx())
    expect(label()).toContain('이용약관 예시.docx')
    expect(desc()).toContain('분석할 준비가 됐어요') // 고른 뒤엔 확인 상태가 읽힌다(2026-10-01)
    w.unmount()
  })
})

describe('S1 입력 방식 탭 — 방향키', () => {
  it('→ · ← 로 옮기면 초점이 탭에 남아 다음 탭으로 계속 갈 수 있다(2026-10-01: 입력칸으로 빠지던 결함)', async () => {
    const w = await mountS1()
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    ;(document.getElementById('tab-file') as HTMLElement).focus()
    await w.find('#tab-file').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement?.id).toBe('tab-url')
    await w.find('#tab-url').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement?.id).toBe('tab-text')
    expect(w.find('#tab-text').attributes('aria-selected')).toBe('true')
    await w.find('#tab-text').trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement?.id).toBe('tab-url')
    // 누르면 입력칸으로 바로 간다(그대로)
    await w.find('#tab-text').trigger('click')
    expect(document.activeElement?.id).toBe('text-input')
    raf.mockRestore()
    w.unmount()
  })
})
