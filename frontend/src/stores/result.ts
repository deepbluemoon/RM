// T082 결과 화면 상태 — 결과·선택 조항·상세 캐시·탭·목록 위치 유지(4.12).
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { toGateView, type GateView } from '@/lib/gates'
import type { ClauseDetail, ClauseNode, ResultView } from '@/api/types'

export type ResultTab = 'verdict' | 'explain' | 'compare' | 'cases'

export const useResultStore = defineStore('result', () => {
  const runId = ref<number | null>(null)
  const result = ref<ResultView | null>(null)
  const gate = ref<GateView | null>(null)
  const loading = ref(false)
  const failed = ref(false)
  const selectedId = ref<number | null>(null)
  const activeTab = ref<ResultTab>('verdict')
  const activeDocId = ref<number | null>(null)
  const listScrollTop = ref(0)
  const details = ref<Record<number, ClauseDetail>>({})
  const detailGate = ref<Record<number, GateView | null>>({})
  const detailLoading = ref(false)

  async function load(id: number) {
    if (runId.value !== id) {
      result.value = null
      selectedId.value = null
      details.value = {}
      detailGate.value = {}
      activeTab.value = 'verdict'
      listScrollTop.value = 0
      activeDocId.value = null
    }
    runId.value = id
    loading.value = true
    gate.value = null
    failed.value = false
    try {
      result.value = await api.result(id)
      if (activeDocId.value == null) activeDocId.value = result.value.documents?.[0]?.documentId ?? null
    } catch (e) {
      if (e instanceof GateApiError) gate.value = toGateView(e.body)
      else failed.value = true
    } finally {
      loading.value = false
    }
  }

  const clauseById = computed(() => {
    const m = new Map<number, ClauseNode>()
    for (const c of result.value?.clauses ?? []) m.set(c.assessmentId, c)
    return m
  })

  const multiDoc = computed(() => (result.value?.documents?.length ?? 0) > 1)

  /** 위험도순 목록(현재 문서) — riskOrder 가 없으면 원문 순서에서 위험 조항만 */
  const riskList = computed<ClauseNode[]>(() => {
    const r = result.value
    if (!r) return []
    const inDoc = (c: ClauseNode) => !multiDoc.value || activeDocId.value == null || c.documentId === activeDocId.value
    if (r.riskOrder?.length) {
      return r.riskOrder.map((id) => clauseById.value.get(id)).filter((c): c is ClauseNode => !!c && inDoc(c))
    }
    const rank = { high: 0, mid: 1, low: 2 } as const
    return r.clauses
      .filter((c) => inDoc(c) && c.displayCategory !== 'normal')
      .sort((a, b) => (a.riskLevel ? rank[a.riskLevel] : 3) - (b.riskLevel ? rank[b.riskLevel] : 3) || a.seq - b.seq)
  })

  const docClauses = computed<ClauseNode[]>(() => {
    const r = result.value
    if (!r) return []
    return r.clauses.filter((c) => !multiDoc.value || activeDocId.value == null || c.documentId === activeDocId.value)
  })

  const selected = computed(() => (selectedId.value != null ? clauseById.value.get(selectedId.value) ?? null : null))
  const selectedDetail = computed(() => (selectedId.value != null ? details.value[selectedId.value] ?? null : null))

  async function select(id: number) {
    selectedId.value = id
    if (!details.value[id]) await loadDetail(id)
  }

  async function loadDetail(id: number, opts: { silent?: boolean } = {}) {
    if (runId.value == null) return
    if (!opts.silent) detailLoading.value = true
    try {
      // 응답을 먼저 받은 뒤 합친다 — `{ ...details.value, [id]: await … }` 는 펼치기를 await 전에 해서, 동시에 받은 다른 조항 결과를 옛 사본으로 덮어썼다(2026-10-01)
      const d = await api.clause(runId.value, id)
      details.value = { ...details.value, [id]: d }
    } catch (e) {
      // 미리 받기(silent) 실패는 조용히 넘긴다 — 그 조항을 고르면 평소처럼 다시 받는다
      if (!opts.silent && e instanceof GateApiError) gate.value = toGateView(e.body)
    } finally {
      if (!opts.silent) detailLoading.value = false
    }
  }

  /** 원문 옆 근거 표시용(2026-10-01) — 위험 조항 상세를 뒤에서 3건씩 미리 받는다. 선택 상태 · 불러오는 중 표시는 건드리지 않는다 */
  async function prefetchDetails(ids: number[], concurrency = 3) {
    const run = runId.value
    const queue = ids.filter((id) => !details.value[id])
    const worker = async () => {
      while (queue.length && runId.value === run) {
        const id = queue.shift()!
        if (!details.value[id]) await loadDetail(id, { silent: true })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  }

  /** 분석 불가 조항 1건 다시 분석(4.5). G5 면 분석 불가 유지 + 조항 안 C2 */
  async function rejudge(id: number): Promise<boolean> {
    if (runId.value == null) return false
    detailGate.value = { ...detailGate.value, [id]: null }
    try {
      const d = await api.rejudge(runId.value, id)
      details.value = { ...details.value, [id]: d }
      if (result.value && d.clause) {
        result.value = {
          ...result.value,
          clauses: result.value.clauses.map((c) => (c.assessmentId === id ? { ...c, ...d.clause } : c)),
        }
      }
      return true
    } catch (e) {
      if (e instanceof GateApiError) detailGate.value = { ...detailGate.value, [id]: toGateView(e.body) }
      return false
    }
  }

  function clearDetailGate(id: number) {
    detailGate.value = { ...detailGate.value, [id]: null }
  }

  return {
    runId, result, gate, loading, failed, selectedId, activeTab, activeDocId, listScrollTop, details, detailGate, detailLoading,
    clauseById, multiDoc, riskList, docClauses, selected, selectedDetail,
    load, select, loadDetail, prefetchDetails, rejudge, clearDetailGate,
  }
})
