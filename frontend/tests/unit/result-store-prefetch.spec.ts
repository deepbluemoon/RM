// 결과 화면 — 원문 옆 근거용 상세 미리 받기(2026-10-01). 동시에 받은 상세가 서로를 덮어쓰지 않아야 한다
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const apiMock = vi.hoisted(() => ({ result: vi.fn(), clause: vi.fn() }))
vi.mock('@/api/endpoints', () => ({ api: apiMock }))
import { useResultStore } from '@/stores/result'

beforeEach(() => {
  setActivePinia(createPinia())
  apiMock.result.mockResolvedValue({ runId: 9, requestId: 1, disclaimer: '', knowledgeDate: '2026-09-29', perspective: 'business', counts: {}, clauses: [] })
  // 늦게 보낸 요청이 먼저 끝나도록 지연을 거꾸로 — 예전 코드(펼치기를 await 전에)는 여기서 앞선 결과를 잃었다
  apiMock.clause.mockImplementation((_run: number, id: number) => new Promise((r) => setTimeout(() => r({ assessmentId: id, displayCategory: 'dispute', evidence: [] }), 40 - id * 5)))
})

describe('result store prefetchDetails', () => {
  it('3건씩 동시에 받아도 모든 조항 상세가 남는다', async () => {
    const s = useResultStore()
    await s.load(9)
    await s.prefetchDetails([1, 2, 3, 4, 5])
    expect(Object.keys(s.details).map(Number).sort()).toEqual([1, 2, 3, 4, 5])
    expect(s.detailLoading).toBe(false) // 미리 받기는 '불러오는 중' 표시를 건드리지 않는다
  })
  it('고른 조항 상세와 미리 받기가 겹쳐도 둘 다 남는다', async () => {
    const s = useResultStore()
    await s.load(9)
    await Promise.all([s.prefetchDetails([2, 3, 4]), s.select(1)])
    expect(Object.keys(s.details).map(Number).sort()).toEqual([1, 2, 3, 4])
    expect(s.selectedDetail?.assessmentId).toBe(1)
  })
})
