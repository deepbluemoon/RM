// S2 개인정보 가리기 · 조항 나누기 — 예측한 계약 유형을 상자에 바로 보이고, 처리가 끝나면 자동으로 다음 화면(위험 찾기)으로 넘어간다(2026-09-30)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = vi.hoisted(() => ({ value: null as any }))
vi.mock('@/stores/analysis', () => ({ useAnalysisStore: () => store.value }))
import S2 from '@/views/S2Structuring.vue'

function makeStore(stage: string, doc: Record<string, unknown>) {
  return reactive({
    status: { requestStage: stage, perspective: 'business', knowledgeDate: '2026-09-29', documents: [{ documentId: 7, docSeq: 1, displayName: '복사한 텍스트', ...doc }], rail: [] },
    phase: 'structuring', cancelled: false, blockingGate: null, accessGate: null, error: null, elapsedSec: 0,
    confirming: false, cancellable: true, cancelling: false, cancelFailed: false, cancelResult: null,
    start: vi.fn(), stop: vi.fn(), cancel: vi.fn(),
    confirmTypes: vi.fn(async () => true),
  })
}
async function mountS2() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div/>' } }] })
  await router.push('/analyses/39/structuring')
  const w = mount(S2, { props: { requestId: '39' }, global: { plugins: [router], stubs: { C1Rail: true, ProgressWaitLine: true } } })
  await flushPromises()
  return { w, router }
}

beforeEach(() => { store.value = null })

describe('S2 계약 유형 상자 · 자동 다음 화면', () => {
  it('예측이 오면 "선택한 파일 : … / 예측한 계약 유형 : …" 두 줄로 바로 보인다(처리 중이면 넘어가지 않음)', async () => {
    store.value = makeStore('structuring', { contractTypeCandidate: 'subscription', summaryStatus: 'ok' })
    const { w, router } = await mountS2()
    const lines = w.findAll('[data-part="contract-type"] p').map((p) => p.text().replace(/\s+/g, ' '))
    expect(lines).toEqual(['파일복사한 텍스트', '계약 유형구독'])
    expect(store.value.confirmTypes).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/analyses/39/structuring')
  })

  it('처리가 끝나면(유형 확정 대기) 예측 결과를 잠시 보여 준 뒤 자동으로 확정하고 위험 찾기 화면으로 넘어간다', async () => {
    vi.useFakeTimers()
    store.value = makeStore('structuring', { contractTypeCandidate: null, summaryStatus: 'pending' })
    const { w, router } = await mountS2()
    expect(w.find('[data-part="contract-type"]').text()).toContain('알아보고 있어요')
    store.value.status.documents[0].contractTypeCandidate = 'subscription'
    store.value.status.requestStage = 'awaiting_type'
    await flushPromises()
    // 넘어가기 전에 예측 결과가 상자에 보인다
    expect(w.find('[data-part="contract-type"]').text().replace(/\s+/g, ' ')).toContain('계약 유형구독')
    expect(w.find('[data-part="auto-next"]').exists()).toBe(true)
    expect(store.value.confirmTypes).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()
    await flushPromises()
    expect(store.value.confirmTypes).toHaveBeenCalledTimes(1)
    expect(store.value.confirmTypes).toHaveBeenCalledWith([{ documentId: 7, contractType: 'subscription' }])
    expect(router.currentRoute.value.path).toBe('/analyses/39/detection')
  })

  it('자동 확정이 실패하면 한 번만 시도하고 "다시 시도" 버튼을 보인다', async () => {
    vi.useFakeTimers()
    store.value = makeStore('awaiting_type', { contractTypeCandidate: 'ecommerce', summaryStatus: 'ok' })
    store.value.confirmTypes = vi.fn(async () => false)
    const { w } = await mountS2()
    await vi.advanceTimersByTimeAsync(1500)
    vi.useRealTimers()
    await flushPromises()
    expect(store.value.confirmTypes).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('다시 시도')
  })
})
