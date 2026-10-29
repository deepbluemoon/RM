// 예시 약관 파일 모션(2026-09-30) — 예시 표시 · 장식 숨김 · 멈춤 버튼 · 모션 줄이기 · 조건부 표시 · 파일 놓는 곳 불변 · 끌어다 놓기
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import SampleFilesMotion from '@/components/common/SampleFilesMotion.vue'

const MARK = 'application/x-crd-sample'
function dropEvent(target: Element, types: string[], data: Record<string, string> = {}) {
  const e = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types, files: [], getData: (k: string) => data[k] ?? '' } })
  target.dispatchEvent(e)
}
// S1 의 파일 놓는 곳 · 숨은 파일 입력칸을 흉내 낸 자리에 컴포넌트를 붙인다
function s1Host() {
  const host = document.createElement('div')
  host.className = 'composer-main'
  host.innerHTML = '<div class="dropzone" data-part="dropzone"><strong>파일을 여기에</strong></div><input type="file" data-part="file-input" /><div id="m"></div>'
  document.body.appendChild(host)
  const input = host.querySelector<HTMLInputElement>('[data-part="file-input"]')!
  let files: unknown = null
  Object.defineProperty(input, 'files', { configurable: true, get: () => files, set: (v) => { files = v } }) // jsdom 은 FileList 만 받는다
  return { host, input, zone: host.querySelector('[data-part="dropzone"]')!, mountAt: host.querySelector('#m')! }
}
function stubDataTransfer() {
  vi.stubGlobal('DataTransfer', class { list: File[] = []; items = { add: (f: File) => this.list.push(f) }; get files() { return this.list } })
}

function mockReduced(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('SampleFilesMotion', () => {
  it('모든 예시 파일에 "예시" 표시가 붙고, 파일 줄은 장식이라 보조기기에서 숨긴다', () => {
    mockReduced(false)
    const w = mount(SampleFilesMotion, { props: { active: true } })
    const cards = w.findAll('.sfm-track .sfm-card')
    expect(cards.length).toBe(6)
    for (const c of cards) {
      expect(c.find('.sfm-tag').text()).toBe('예시')
      expect(c.attributes('draggable')).toBe('true')
    }
    // 예시 3종 × 두 벌(끊김 없는 반복) — 짧은 것부터(2026-10-01)
    expect(cards.map((c) => c.find('.sfm-name').text())).toEqual(['모람 콘텐츠 이용약관', '모람 콘텐츠 서비스 이용약관', '세모 온라인 학습 서비스 이용약관', '모람 콘텐츠 이용약관', '모람 콘텐츠 서비스 이용약관', '세모 온라인 학습 서비스 이용약관'])
    expect(cards.slice(0, 3).map((c) => c.find('.sfm-kind').text())).toEqual(['HWPX', 'PDF', 'HWP'])
    expect(w.find('.sfm-track').attributes('aria-hidden')).toBe('true')
    expect(w.findAll('.sfm-card a, .sfm-card button')).toHaveLength(0) // 누르기로는 넣지 않는다 — 끌어다 놓기만
    expect(w.find('[data-part="sample-hint"]').text()).toBe('예시 파일을 누르거나 위쪽 파일 놓는 곳으로 끌어다 놓아 보세요')
  })

  it('멈춤 버튼으로 멈추고 다시 볼 수 있다(WCAG 2.2.2)', async () => {
    mockReduced(false)
    const w = mount(SampleFilesMotion, { props: { active: true } })
    const btn = w.find('[data-action="sample-motion-toggle"]')
    expect(btn.attributes('aria-pressed')).toBe('false')
    expect(w.classes()).not.toContain('paused')
    await btn.trigger('click')
    expect(btn.attributes('aria-pressed')).toBe('true')
    expect(btn.text()).toBe('예시 움직임 다시 보기')
    expect(w.classes()).toContain('paused')
  })

  it('파일을 골랐거나 다른 입력 방식이면(active=false) 아무것도 그리지 않는다', () => {
    mockReduced(false)
    const w = mount(SampleFilesMotion, { props: { active: false } })
    expect(w.find('[data-part="sample-motion"]').exists()).toBe(false)
  })

  it('모션 줄이기 설정이면 멈춘 줄만 보이고 멈춤 버튼 · 떠오르는 파일이 없다', async () => {
    vi.useFakeTimers()
    mockReduced(true)
    const w = mount(SampleFilesMotion, { props: { active: true, intervalMs: 100 } })
    await flushPromises()
    expect(w.classes()).toContain('still')
    expect(w.find('[data-action="sample-motion-toggle"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(w.find('[data-part="sample-ghost"]').exists()).toBe(false)
  })

  it('입력 방식을 바꿨다 돌아와도(active 꺼짐→켜짐) 새 요소를 다시 감시해 멈춘 채 굳지 않는다 — 결함 1 회귀', async () => {
    mockReduced(false)
    const observed: Element[] = []
    const unobserved: Element[] = []
    let cb: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null = null
    vi.stubGlobal('IntersectionObserver', class {
      constructor(fn: typeof cb) { cb = fn }
      observe(el: Element) { observed.push(el) }
      unobserve(el: Element) { unobserved.push(el) }
      disconnect() {}
    })
    const w = mount(SampleFilesMotion, { props: { active: true } })
    await flushPromises()
    const first = w.find('[data-part="sample-motion"]').element
    expect(observed).toEqual([first])
    await w.setProps({ active: false }) // 주소 탭
    await flushPromises()
    cb!([{ target: first, isIntersecting: false }]) // 사라진 옛 요소의 늦은 '안 보임' 신호
    await w.setProps({ active: true }) // 파일 탭 복귀
    await flushPromises()
    const second = w.find('[data-part="sample-motion"]').element
    expect(second).not.toBe(first)
    expect(unobserved).toContain(first)
    expect(observed.at(-1)).toBe(second)
    cb!([{ target: first, isIntersecting: false }]) // 옛 요소 신호는 다시 와도 무시
    await flushPromises()
    expect(w.find('[data-part="sample-motion"]').classes()).not.toContain('paused')
    cb!([{ target: second, isIntersecting: false }]) // 지금 요소가 화면 밖으로 나가면 멈춘다
    await flushPromises()
    expect(w.find('[data-part="sample-motion"]').classes()).toContain('paused')
  })

  it('떠오르는 파일은 반투명 복제본으로 나타났다가 사라지고, 파일 놓는 곳의 문구는 바꾸지 않는다', async () => {
    vi.useFakeTimers()
    mockReduced(false)
    const host = document.createElement('div')
    host.className = 'composer-main'
    host.innerHTML = '<div class="dropzone">파일을 여기에 끌어다 놓거나 눌러서 고르세요</div><div id="m"></div>'
    document.body.appendChild(host)
    let finish: (() => void) | null = null
    // jsdom 은 레이아웃·Web Animations 가 없다 — offsetParent · animate 를 흉내 낸다
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return document.body } })
    ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = function () { const a = { onfinish: null as null | (() => void), cancel: vi.fn() }; finish = () => a.onfinish?.(); return a }
    const w = mount(SampleFilesMotion, { props: { active: true, intervalMs: 100 }, attachTo: host.querySelector('#m')! })
    await vi.advanceTimersByTimeAsync(120)
    await flushPromises()
    const g = w.find('[data-part="sample-ghost"]')
    expect(g.exists()).toBe(true)
    expect(g.find('.sfm-tag').text()).toBe('예시')
    expect(g.attributes('aria-hidden')).toBe('true')
    finish!()
    await flushPromises()
    expect(w.find('[data-part="sample-ghost"]').exists()).toBe(false)
    expect(host.querySelector('.dropzone')!.textContent).toBe('파일을 여기에 끌어다 놓거나 눌러서 고르세요')
    w.unmount(); host.remove()
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
    delete (HTMLElement.prototype as unknown as { offsetParent?: unknown }).offsetParent
  })

  it('끌기 시작하면 흐름을 멈추고 예시 표식을 싣는다', async () => {
    mockReduced(false)
    const w = mount(SampleFilesMotion, { props: { active: true } })
    const data: Record<string, string> = {}
    const e = new Event('dragstart', { bubbles: true })
    Object.defineProperty(e, 'dataTransfer', { value: { setData: (k: string, v: string) => { data[k] = v }, effectAllowed: '' } })
    w.find('.sfm-track .sfm-card').element.dispatchEvent(e)
    await flushPromises()
    expect(data[MARK]).toBe('moram-short') // 끈 카드의 예시 id
    expect(data['text/plain']).toBe('모람 콘텐츠 이용약관(예시).hwpx')
    expect(w.classes()).toContain('dragging')
    expect(w.classes()).toContain('paused')
    await w.find('.sfm-track .sfm-card').trigger('dragend')
    expect(w.classes()).not.toContain('dragging')
  })

  it('파일 놓는 곳에 놓으면 예시 파일을 숨은 입력칸에 채우고 change 를 보낸다(S1 의 onFile 경로)', async () => {
    mockReduced(false); stubDataTransfer()
    const fetchMock = vi.fn(async () => new Response(new Blob(['docx-bytes']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { host, input, zone, mountAt } = s1Host()
    const changed: File[] = []
    input.addEventListener('change', () => changed.push(...((input.files as unknown as File[]) ?? [])))
    const w = mount(SampleFilesMotion, { props: { active: true }, attachTo: mountAt })
    dropEvent(zone.querySelector('strong')!, [MARK, 'text/plain'], { [MARK]: 'moram-service' }) // 안쪽 글자 위에 놓아도 된다 · 끈 카드 = PDF
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith('/samples/moram-content-service-terms.pdf')
    expect(changed).toHaveLength(1)
    expect(changed[0].name).toBe('모람 콘텐츠 서비스 이용약관(예시).pdf')
    expect(changed[0].type).toBe('application/pdf')
    expect(w.find('[data-part="sample-drop-failed"]').exists()).toBe(false)
    w.unmount(); host.remove()
  })

  it('카드를 누르거나 "예시 약관 넣기" 버튼을 누르면 같은 경로로 넣는다(예시 문서 칸 대체, 2026-09-30)', async () => {
    mockReduced(false); stubDataTransfer()
    const fetchMock = vi.fn(async () => new Response(new Blob(['docx-bytes']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { host, input, mountAt } = s1Host()
    const changed: File[] = []
    input.addEventListener('change', () => changed.push(...((input.files as unknown as File[]) ?? [])))
    const w = mount(SampleFilesMotion, { props: { active: true }, attachTo: mountAt })
    await w.find('.sfm-track .sfm-card').trigger('click')
    await flushPromises()
    expect(changed.map((f) => f.name)).toEqual(['모람 콘텐츠 이용약관(예시).hwpx'])
    const btns = w.findAll('[data-action="sample-use"]')
    expect(btns).toHaveLength(3) // 파일마다 움직이지 않는 대안 — 키보드 · 휴대폰
    expect(btns.every((b) => b.element.tagName === 'BUTTON')).toBe(true)
    expect(btns.map((b) => b.text())).toEqual(['HWPX모람 콘텐츠 이용약관', 'PDF모람 콘텐츠 서비스 이용약관', 'HWP세모 온라인 학습 서비스 이용약관'])
    await btns[2].trigger('click')
    await flushPromises()
    expect(changed.map((f) => f.name)).toEqual(['모람 콘텐츠 이용약관(예시).hwpx', '세모 온라인 학습 서비스 이용약관(예시).hwp'])
    expect(fetchMock).toHaveBeenLastCalledWith('/samples/semo-online-learning-terms.hwp')
    w.unmount(); host.remove()
  })

  it('예시 표식이 없는 드롭 · 파일 놓는 곳 밖의 드롭은 무시한다(사용자 파일 드롭은 S1 이 그대로 처리)', async () => {
    mockReduced(false); stubDataTransfer()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { host, zone, mountAt } = s1Host()
    const w = mount(SampleFilesMotion, { props: { active: true }, attachTo: mountAt })
    dropEvent(zone, ['Files'])
    dropEvent(host.querySelector('#m')!, [MARK])
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
    w.unmount(); host.remove()
  })

  it('예시 파일을 못 받으면 다시 눌러 달라고 알린다', async () => {
    mockReduced(false); stubDataTransfer()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const { host, zone, mountAt } = s1Host()
    const w = mount(SampleFilesMotion, { props: { active: true }, attachTo: mountAt })
    dropEvent(zone, [MARK])
    await flushPromises()
    const err = w.find('[data-part="sample-drop-failed"]')
    expect(err.attributes('role')).toBe('alert')
    expect(err.text()).toContain('다시 눌러')
    w.unmount(); host.remove()
  })

  it('코드가 가리키는 예시 파일이 public/samples 에 모두 있다(없으면 화면에서 "넣지 못했어요"가 된다)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/components/common/SampleFilesMotion.vue'), 'utf8')
    const urls = [...src.matchAll(/url: '(\/samples\/[^']+)'/g)].map((m) => m[1])
    expect(urls).toHaveLength(3)
    for (const u of urls) expect(existsSync(resolve(__dirname, '../../public', u.slice(1))), u).toBe(true)
  })

  it('S1Intake 의 의존 표식이 그대로 있다(바뀌면 끌어다 놓기가 조용히 고장 — 여기서 먼저 잡는다)', () => {
    const s1 = readFileSync(resolve(__dirname, '../../src/views/S1Intake.vue'), 'utf8')
    expect(s1).toContain('data-part="dropzone"')
    expect(s1).toMatch(/type="file"[^>]*data-part="file-input"[^>]*@change="onFile"/)
    expect(s1).toContain('<SampleFilesMotion')
  })
})
