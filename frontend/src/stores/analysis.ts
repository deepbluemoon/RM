// T082 분석 진행 상태 — 2초 폴링(GET /analyses/{id}), 단계·게이트, 경과 시간 로컬 틱, 취소·결과 저장.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { toGateView, gateFromCode, type GateView } from '@/lib/gates'
import type { AnalysisStatus, CancelResult, ContractType } from '@/api/types'

export const POLL_MS = 2000
const TERMINAL_RUN = new Set(['completed', 'saved', 'aborted'])

export const useAnalysisStore = defineStore('analysis', () => {
  const requestId = ref<number | null>(null)
  const status = ref<AnalysisStatus | null>(null)
  /** GET 자체가 게이트로 막힌 경우(G8 등) — 화면 전체 대체 */
  const accessGate = ref<GateView | null>(null)
  /** 동작(확정·저장) 중 받은 게이트 */
  const actionGate = ref<GateView | null>(null)
  const error = ref<string | null>(null)
  const polling = ref(false)
  const fetchedAt = ref(0)
  const nowMs = ref(Date.now())
  const cancelResult = ref<CancelResult | null>(null)
  const cancelling = ref(false)
  const cancelFailed = ref(false)
  const saving = ref(false)
  const confirming = ref(false)
  /** 재분석 진입 시 기다릴 새 실행 ID — 상태가 아직 이전(저장된) 실행을 보이면 계속 폴링한다 */
  const expectRunId = ref<number | null>(null)
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null

  function needsPolling(s: AnalysisStatus | null): boolean {
    if (!s) return true
    if (expectRunId.value != null && s.run?.runId !== expectRunId.value) return true
    if (s.requestStage === 'stopped' || s.requestStage === 'awaiting_type') return false
    if (s.run?.stage && TERMINAL_RUN.has(s.run.stage)) return false
    return true
  }

  async function fetchOnce(): Promise<void> {
    if (requestId.value == null) return
    const id = requestId.value
    try {
      const s = await api.analysisStatus(id)
      if (id !== requestId.value) return
      status.value = s
      fetchedAt.value = Date.now()
      nowMs.value = fetchedAt.value
      error.value = null
    } catch (e) {
      if (e instanceof GateApiError) {
        accessGate.value = toGateView(e.body)
        stop()
        return
      }
      error.value = '진행 상태를 받지 못했어요. 알아서 다시 시도하고 있어요'
    }
  }

  function schedule() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => {
      pollTimer = null
      if (!polling.value) return
      await fetchOnce()
      if (polling.value && needsPolling(status.value) && !accessGate.value) schedule()
      else stopPollingOnly()
    }, POLL_MS)
  }

  function stopPollingOnly() {
    polling.value = false
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  async function start(id: number, opts: { expectRunId?: number | null } = {}): Promise<void> {
    if (requestId.value !== id) reset()
    requestId.value = id
    expectRunId.value = opts.expectRunId ?? null
    if (!tickTimer) tickTimer = setInterval(() => (nowMs.value = Date.now()), 1000)
    polling.value = true
    await fetchOnce()
    if (needsPolling(status.value) && !accessGate.value) schedule()
    else stopPollingOnly()
  }

  function resume() {
    if (requestId.value == null || accessGate.value) return
    polling.value = true
    schedule()
  }

  function stop() {
    stopPollingOnly()
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
  }

  function reset() {
    stop()
    status.value = null
    accessGate.value = null
    actionGate.value = null
    error.value = null
    cancelResult.value = null
    cancelFailed.value = false
    fetchedAt.value = 0
  }

  /** 경과 초 — 서버 elapsedSec + 마지막 수신 이후 로컬 틱(폴링 중일 때만) */
  const elapsedSec = computed<number | null>(() => {
    const s = status.value
    if (!s || s.elapsedSec == null) return null
    if (!polling.value || !fetchedAt.value) return s.elapsedSec
    return s.elapsedSec + Math.max(0, Math.floor((nowMs.value - fetchedAt.value) / 1000))
  })

  /** 화면 전체를 멈추는 게이트(G5·G6·G7). openGates 의 full 범위 또는 중단 상태에서 유도 */
  const blockingGate = computed<GateView | null>(() => {
    if (actionGate.value) return actionGate.value
    const s = status.value
    if (!s) return null
    const og = s.openGates?.find((g) => g.scope === 'full') ?? s.openGates?.find((g) => ['G5', 'G6', 'G7'].includes(g.gate))
    if (og) return toGateView(og)
    if (s.run?.stage === 'aborted' && !cancelResult.value) return gateFromCode('G5')
    return null
  })

  const phase = computed<'structuring' | 'detection'>(() => {
    const s = status.value
    if (!s) return 'structuring'
    if (s.run) return 'detection'
    return s.requestStage === 'type_confirmed' ? 'detection' : 'structuring'
  })
  const awaitingRun = computed(() => expectRunId.value != null && status.value?.run?.runId !== expectRunId.value)
  const completed = computed(
    () => !awaitingRun.value && (status.value?.run?.stage === 'completed' || status.value?.run?.stage === 'saved'),
  )
  const cancelled = computed(() => !!cancelResult.value)
  const cancellable = computed(() => !!status.value?.cancellable && !cancelResult.value)
  const isReanalysis = computed(() => status.value?.run?.runKind === 'reanalysis')

  async function confirmTypes(choices: { documentId: number; contractType: ContractType }[]): Promise<boolean> {
    if (requestId.value == null) return false
    confirming.value = true
    actionGate.value = null
    try {
      for (const c of choices) {
        status.value = await api.confirmContractType(requestId.value, c.documentId, c.contractType)
      }
      fetchedAt.value = Date.now()
      resume()
      return true
    } catch (e) {
      if (e instanceof GateApiError) actionGate.value = toGateView(e.body)
      else error.value = '계약 유형을 정하지 못했어요. 다시 시도해 주세요'
      return false
    } finally {
      confirming.value = false
    }
  }

  async function cancel(): Promise<boolean> {
    if (requestId.value == null) return false
    cancelling.value = true
    cancelFailed.value = false
    try {
      const r = await api.cancelAnalysis(requestId.value)
      cancelResult.value = r
      stopPollingOnly()
      await fetchOnce()
      return true
    } catch (e) {
      if (e instanceof GateApiError) accessGate.value = toGateView(e.body)
      cancelFailed.value = true
      return false
    } finally {
      cancelling.value = false
    }
  }

  /** "결과 보기" — 결과 저장(H3). 성공 시 결과 경로를 돌려준다 */
  async function save(): Promise<string | null> {
    const s = status.value
    if (requestId.value == null || !s?.run?.runId) return null
    saving.value = true
    try {
      const r = await api.saveRun(requestId.value, s.run.runId)
      return r.resultUrl || `/results/${r.runId}`
    } catch (e) {
      if (e instanceof GateApiError) actionGate.value = toGateView(e.body)
      else error.value = '결과를 저장하지 못했어요. 다시 시도해 주세요'
      return null
    } finally {
      saving.value = false
    }
  }

  return {
    requestId, expectRunId, status, accessGate, actionGate, error, polling, cancelResult, cancelling, cancelFailed, saving, confirming,
    elapsedSec, blockingGate, phase, completed, cancelled, cancellable, isReanalysis,
    start, stop, reset, resume, fetchOnce, confirmTypes, cancel, save,
  }
})
