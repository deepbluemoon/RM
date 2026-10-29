// 2026-10-01 — 진행 막대(퍼센트), 끝난 레일 단계 펼치기, 분석 기록 문서 펼치기
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

const apiMock = vi.hoisted(() => ({ history: vi.fn(), historyDetail: vi.fn(), result: vi.fn(), impacts: vi.fn(), modelServerStatus: vi.fn() }))
vi.mock('@/api/endpoints', () => ({ api: apiMock }))
import ProgressMeter from '@/components/common/ProgressMeter.vue'
import C1Rail from '@/components/common/C1Rail.vue'
import S6History from '@/views/S6History.vue'
import { routes } from '@/router'

beforeEach(() => {
  setActivePinia(createPinia())
  Object.values(apiMock).forEach((f) => f.mockReset())
})

describe('ProgressMeter', () => {
  it('퍼센트를 크게, 막대는 progressbar 로 알린다(0~100 으로 자름)', () => {
    const w = mount(ProgressMeter, { props: { percent: 142.4, label: '진행' }, slots: { default: '조항 <b>100개</b>' } })
    expect(w.find('[data-part="progress-percent"]').text()).toBe('100%')
    expect(w.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    expect(w.find('.pm-text b').text()).toBe('100개')
  })
  it('아직 모르면 — 표시', () => {
    const w = mount(ProgressMeter, { props: { percent: null, label: '진행' } })
    expect(w.find('[data-part="progress-percent"]').text()).toBe('—')
  })
})

describe('C1 끝난 단계 펼치기', () => {
  it('info 가 있는 단계는 버튼 — 누르면 내용 · 미리보기, 다시 누르면 닫힘. info 없는 단계는 그대로 글자', async () => {
    const w = mount(C1Rail, {
      props: { steps: [
        { label: '계약서 넣기', state: 'done', info: { title: '넣은 계약서', lines: ['**약관.docx** · 계약 유형 구독'], preview: ['제1조 〔이름〕은 …'] } },
        { label: '결과', state: 'now' },
      ] },
      attachTo: document.body,
    })
    const btn = w.find('button.step')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(w.findAll('span.step')).toHaveLength(1)
    await btn.trigger('click')
    expect(btn.attributes('aria-expanded')).toBe('true')
    expect(w.find('[data-part="rail-info"] li b').text()).toBe('약관.docx')
    expect(w.find('[data-part="rail-preview"] .mask').exists()).toBe(true) // 가림 표기 그대로
    await btn.trigger('click')
    expect(w.find('[data-part="rail-info"]').exists()).toBe(false)
    w.unmount()
  })
  it('굵게 표기 외의 HTML 은 글자로 보인다', async () => {
    const w = mount(C1Rail, { props: { steps: [{ label: 'a', state: 'done', info: { title: 't', lines: ['<img src=x>**1**'] } }] } })
    await w.find('button.step').trigger('click')
    const li = w.find('[data-part="rail-info"] li')
    expect(li.find('img').exists()).toBe(false)
    expect(li.text()).toContain('<img src=x>')
  })
})

describe('S6 문서 펼치기', () => {
  it('문서 이름을 누르면 그 줄 아래가 열리고 요약 · 위험 조항 · 기록을 보인다. 체크박스는 바뀌지 않는다', async () => {
    apiMock.history.mockResolvedValue({ items: [{ requestId: 7, latestRunId: 70, displayName: '약관.docx', requestedAt: '2026-09-30T00:00:00Z', knowledgeDate: '2026-09-29', counts: { high: 1, mid: 0, low: 0 } }] })
    apiMock.modelServerStatus.mockResolvedValue({ state: 'ready', checkedAt: '2026-10-01T00:00:00Z' })
    apiMock.historyDetail.mockResolvedValue({ requestId: 7, runs: [{ runId: 70, runKind: 'analysis', savedAt: '2026-09-30T00:00:00Z' }] })
    apiMock.result.mockResolvedValue({ runId: 70, requestId: 7, disclaimer: '', knowledgeDate: '2026-09-29', perspective: 'business', counts: { high: 1 }, documents: [{ documentId: 1, summary: '구독 약관 요약' }], clauses: [{ assessmentId: 3, clauseId: 3, seq: 1, articleNo: '제5조', text: '환불되지 않습니다.', displayCategory: 'illegal', riskLevel: 'high' }], riskOrder: [3] })
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/history')
    const w = mount(S6History, { global: { plugins: [router] } })
    await flushPromises()
    const t = w.find('[data-part="row-toggle"]')
    expect(t.attributes('aria-expanded')).toBe('false')
    expect(w.find('.grow').classes()).not.toContain('open')
    await t.trigger('click')
    await flushPromises()
    expect(t.attributes('aria-expanded')).toBe('true')
    expect(w.find('.grow').classes()).toContain('open')
    expect(w.find('.row-panel').text()).toContain('구독 약관 요약')
    expect(w.find('.rp-risks').text()).toContain('제5조')
    expect(w.find('.rp-runs').text()).toContain('결과 열기')
    expect((w.find('[data-part="row-check"]').element as HTMLInputElement).checked).toBe(false)
    expect(apiMock.historyDetail).toHaveBeenCalledTimes(1)
    await t.trigger('click')
    expect(w.find('.grow').classes()).not.toContain('open')
  })
})
