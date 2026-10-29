// 진행 중 판정 결과 먼저 보이기(2026-09-30) — S3 가 판정을 마친 위험 조항을 판정 순서대로 보여 주고, 남은 수를 알린다
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'

const fake = vi.hoisted(() => ({ store: null as any }))
vi.mock('@/stores/analysis', () => ({ useAnalysisStore: () => fake.store }))

import S3Detection from '@/views/S3Detection.vue'

function makeStore(run: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return reactive({
    status: {
      requestId: 1, perspective: 'business', knowledgeDate: '2026-09-29', requestStage: 'type_confirmed',
      rail: [], documents: [{ documentId: 1, docSeq: 1, displayName: 'a', ocrApplied: false, contractType: 'ecommerce' }],
      run: { runId: 9, runKind: 'analysis', stage: 'explaining', clauseTotal: 60, scoredCount: 60, ...run },
      openGates: [], elapsedSec: 10, modelNotice: null, cancellable: true,
    },
    start: vi.fn(), stop: vi.fn(), fetchOnce: vi.fn(), save: vi.fn(async () => null), cancel: vi.fn(),
    isReanalysis: false, blockingGate: null, accessGate: null, completed: false, cancelled: false, cancelResult: null,
    error: null, elapsedSec: 10, cancellable: true, cancelling: false, cancelFailed: false, saving: false, ...extra,
  })
}

async function mountS3() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { template: '<div/>' } }] })
  await router.push('/analyses/1/detection')
  const w = mount(S3Detection, { props: { requestId: '1' }, global: { plugins: [router] } })
  await flushPromises()
  return w
}

describe('S3 진행 중 위험 조항 먼저 보이기', () => {
  it('판정을 마친 위험 조항을 받은 순서대로, 남은 수와 함께 보인다', async () => {
    fake.store = makeStore({
      riskTotal: 12, judgedCount: 3, judgedNormalCount: 0,
      judged: [
        { clauseId: 11, seq: 4, articleNo: '제15조', itemNo: '3.', title: '회사의 의무', category: 'unfair', preview: '회사가 제공하는 서비스로 인하여' },
        { clauseId: 12, seq: 7, articleNo: '제16조', paragraphNo: '①', category: 'dispute', preview: '제15조의 사유로 인한 계약의 해제' },
      ],
    })
    const w = await mountS3()
    expect(w.find('[data-part="progress"]').text()).toContain('위험해 보이는 조항 12개 중 3개를 판단했어요')
    const items = w.findAll('[data-part="live-item"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('제15조 3. 회사의 의무')
    expect(items[0]!.text()).toContain('불공정 가능')
    expect(items[1]!.text()).toContain('분쟁 가능')
    expect(w.find('[data-part="live-pending"]').text()).toContain('남은 9개')
  })

  it('판정 단계 전(위험 후보 수 없음)에는 목록을 숨기고 기존 문구를 쓴다', async () => {
    fake.store = makeStore({ stage: 'detecting', scoredCount: 20 })
    const w = await mountS3()
    expect(w.find('[data-part="live"]').exists()).toBe(false)
    expect(w.find('[data-part="progress"]').text()).toBe('조항 60개 중 20개를 살펴봤어요')
  })

  it('정상으로 판정된 후보는 목록에서 빼고 개수만 알린다', async () => {
    fake.store = makeStore({ riskTotal: 2, judgedCount: 2, judgedNormalCount: 2, judged: [] }, { completed: true })
    const w = await mountS3()
    expect(w.find('[data-part="live"]').text()).toContain('살펴보니 문제없는 조항 2개는 목록에서 뺐어요')
    expect(w.find('[data-part="live-pending"]').exists()).toBe(false)
  })
})
