// T082·T145 — 분석 진행 폴링(가짜 타이머), 경과 시간 로컬 틱, 취소 흐름
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { AnalysisStatus } from '@/api/types'

const apiMock = vi.hoisted(() => ({
  analysisStatus: vi.fn(),
  cancelAnalysis: vi.fn(),
  saveRun: vi.fn(),
  confirmContractType: vi.fn(),
}))
vi.mock('@/api/endpoints', () => ({ api: apiMock }))

import { useAnalysisStore, POLL_MS } from '@/stores/analysis'
import { GateApiError } from '@/api/client'

function status(p: Partial<AnalysisStatus> = {}): AnalysisStatus {
  return {
    requestId: 7,
    perspective: 'business',
    knowledgeDate: '2026-09-15',
    requestStage: 'structuring',
    rail: [{ step: 'received', state: 'done' }, { step: 'deidentify', state: 'running' }],
    openGates: [],
    elapsedSec: 10,
    cancellable: true,
    ...p,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T10:00:00Z'))
  Object.values(apiMock).forEach((f) => f.mockReset())
})
afterEach(() => {
  vi.useRealTimers()
})

describe('analysis store — 2초 폴링', () => {
  it('2초마다 GET 하고, 유형 확인 대기에서 멈춘다', async () => {
    apiMock.analysisStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ elapsedSec: 12 }))
      .mockResolvedValueOnce(status({ requestStage: 'awaiting_type', elapsedSec: 14 }))
    const s = useAnalysisStore()
    await s.start(7)
    expect(apiMock.analysisStatus).toHaveBeenCalledTimes(1)
    expect(s.polling).toBe(true)
    await vi.advanceTimersByTimeAsync(POLL_MS - 1)
    expect(apiMock.analysisStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(apiMock.analysisStatus).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(apiMock.analysisStatus).toHaveBeenCalledTimes(3)
    expect(s.status?.requestStage).toBe('awaiting_type')
    expect(s.polling).toBe(false)
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(apiMock.analysisStatus).toHaveBeenCalledTimes(3)
    s.stop()
  })

  it('경과 시간은 폴링 사이에도 1초씩 로컬로 흐른다', async () => {
    apiMock.analysisStatus.mockResolvedValue(status({ elapsedSec: 60 }))
    const s = useAnalysisStore()
    await s.start(7)
    expect(s.elapsedSec).toBe(60)
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.elapsedSec).toBe(61)
    // 다음 폴링이 서버 값으로 다시 맞춘다
    apiMock.analysisStatus.mockResolvedValue(status({ elapsedSec: 63 }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.elapsedSec).toBe(63)
    s.stop()
  })

  it('실행 완료(completed)에서 멈추고 탐지 단계로 판단한다', async () => {
    apiMock.analysisStatus.mockResolvedValue(
      status({ requestStage: 'type_confirmed', run: { runId: 3, runKind: 'analysis', stage: 'completed', clauseTotal: 42, scoredCount: 42 } }),
    )
    const s = useAnalysisStore()
    await s.start(7)
    expect(s.polling).toBe(false)
    expect(s.phase).toBe('detection')
    expect(s.completed).toBe(true)
    s.stop()
  })

  it('openGates 의 G5(full) 를 차단 게이트로, aborted 도 G5 로 본다', async () => {
    apiMock.analysisStatus.mockResolvedValue(
      status({ requestStage: 'type_confirmed', run: { runId: 3, stage: 'aborted' }, openGates: [{ gate: 'G5', title: '분석 일시 불가', scope: 'full' }] }),
    )
    const s = useAnalysisStore()
    await s.start(7)
    expect(s.blockingGate?.gate).toBe('G5')
    expect(s.blockingGate?.reason).toContain('서버가 복구되면 다시 시도해 주세요')
    s.stop()
  })

  it('GET 이 G8 GateError 면 폴링을 멈추고 접근 차단', async () => {
    apiMock.analysisStatus.mockRejectedValue(
      new GateApiError(404, { gate: 'G8', title: '결과를 볼 수 없습니다', reason: '세션이 만료되었습니다', releaseActor: 'user', nextActions: [] }),
    )
    const s = useAnalysisStore()
    await s.start(7)
    expect(s.accessGate?.gate).toBe('G8')
    expect(s.polling).toBe(false)
  })

  it('일시 오류는 게이트가 아니며 폴링을 계속한다', async () => {
    apiMock.analysisStatus.mockRejectedValueOnce(new Error('network')).mockResolvedValue(status())
    const s = useAnalysisStore()
    await s.start(7)
    expect(s.error).toContain('다시 시도')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(apiMock.analysisStatus).toHaveBeenCalledTimes(2)
    expect(s.error).toBeNull()
    s.stop()
  })
})

describe('analysis store — 취소(FR-035)', () => {
  it('cancel → 폴링 중지, 취소 가능 해제(이용 한도 없음)', async () => {
    apiMock.analysisStatus.mockResolvedValueOnce(status()).mockResolvedValue(status({ requestStage: 'stopped', cancellable: false }))
    apiMock.cancelAnalysis.mockResolvedValue({ requestId: 7 })
    const s = useAnalysisStore()
    await s.start(7)
    expect(s.cancellable).toBe(true)
    const ok = await s.cancel()
    expect(ok).toBe(true)
    expect(apiMock.cancelAnalysis).toHaveBeenCalledWith(7)
    expect(s.cancelResult?.requestId).toBe(7)
    expect(s.cancellable).toBe(false)
    expect(s.cancelled).toBe(true)
    const calls = apiMock.analysisStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(apiMock.analysisStatus.mock.calls.length).toBe(calls)
    // 취소는 G5 로 오인하지 않는다
    expect(s.blockingGate).toBeNull()
    s.stop()
  })

  it('취소 실패는 cancelFailed 로만 표시', async () => {
    apiMock.analysisStatus.mockResolvedValue(status())
    apiMock.cancelAnalysis.mockRejectedValue(new Error('x'))
    const s = useAnalysisStore()
    await s.start(7)
    expect(await s.cancel()).toBe(false)
    expect(s.cancelFailed).toBe(true)
    s.stop()
  })
})

describe('analysis store — 결과 보기(save)', () => {
  it('저장 성공 시 결과 경로, G7 이면 actionGate', async () => {
    apiMock.analysisStatus.mockResolvedValue(
      status({ requestStage: 'type_confirmed', run: { runId: 3, stage: 'completed' } }),
    )
    apiMock.saveRun.mockResolvedValueOnce({ runId: 3, resultUrl: '/results/3' })
    const s = useAnalysisStore()
    await s.start(7)
    expect(await s.save()).toBe('/results/3')
    apiMock.saveRun.mockRejectedValueOnce(
      new GateApiError(409, { gate: 'G7', title: '결과 제공 보류', reason: 'r', releaseActor: 'operator', nextActions: [] }),
    )
    expect(await s.save()).toBeNull()
    expect(s.blockingGate?.gate).toBe('G7')
    s.stop()
  })
})

describe('analysis store — 재분석 진입', () => {
  it('새 실행 ID 가 보일 때까지 이전 saved 실행을 완료로 보지 않고 폴링한다', async () => {
    apiMock.analysisStatus
      .mockResolvedValueOnce(status({ requestStage: 'type_confirmed', run: { runId: 3, runKind: 'analysis', stage: 'saved' } }))
      .mockResolvedValueOnce(status({ requestStage: 'type_confirmed', run: { runId: 9, runKind: 'reanalysis', stage: 'detecting' } }))
      .mockResolvedValue(status({ requestStage: 'type_confirmed', run: { runId: 9, runKind: 'reanalysis', stage: 'completed' } }))
    const s = useAnalysisStore()
    await s.start(7, { expectRunId: 9 })
    expect(s.completed).toBe(false)
    expect(s.polling).toBe(true)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(s.isReanalysis).toBe(true)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(s.completed).toBe(true)
    expect(s.polling).toBe(false)
    s.stop()
  })
})
