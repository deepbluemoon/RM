<script setup lang="ts">
// S6 분석 기록 관리·재분석 (SD_02 §10) — T119. 로그인 계정으로 만든 기록만 보인다. 재분석은 G5 만 막는다.
// 2026-09-30: 행 선택은 체크박스 — 하나를 고르면 자세히 보기 · 다시 분석, 여러 개를 고르면 한꺼번에 삭제.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { gateFromCode, toGateView, type GateView } from '@/lib/gates'
import { CHANGE_KIND, CONTRACT_TYPE, PERSPECTIVE, RISK_LEVEL } from '@/lib/labels'
import { ymd, ymdhm, evidenceName } from '@/lib/format'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import C11ModelServerState from '@/components/common/C11ModelServerState.vue'
import DeleteConfirm from '@/components/common/DeleteConfirm.vue'
import type { HistoryDetail, HistoryItem, ModelServerStatus, ResultImpact, ResultView } from '@/api/types'

const route = useRoute()
const router = useRouter()

const items = ref<HistoryItem[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const listFailed = ref(false)
const accessGate = ref<GateView | null>(null)
const checked = ref<number[]>([])
const selectedId = ref<number | null>(null)
const detail = ref<HistoryDetail | null>(null)
const impacts = ref<ResultImpact[] | null>(null)
const reGate = ref<GateView | null>(null)
const reBusy = ref(false)
const reFailed = ref(false)
const ms = ref<ModelServerStatus | null>(null)
const msLoading = ref(false)
const msFailed = ref(false)
const delOpen = ref(false)
const deleting = ref(false)
const delFailed = ref(false)

async function loadList(more = false) {
  loading.value = true
  listFailed.value = false
  try {
    const r = await api.history(more ? nextCursor.value : null)
    items.value = more ? [...items.value, ...(r.items ?? [])] : r.items ?? []
    nextCursor.value = r.nextCursor ?? null
  } catch (e) {
    if (e instanceof GateApiError) accessGate.value = toGateView(e.body)
    else listFailed.value = true
  } finally {
    loading.value = false
  }
}

async function loadModelStatus() {
  msLoading.value = true
  try {
    ms.value = await api.modelServerStatus()
    msFailed.value = false
    if (reGate.value?.gate === 'G5' && ms.value.state !== 'unreachable') reGate.value = null
  } catch {
    msFailed.value = true
  } finally {
    msLoading.value = false
  }
}

onMounted(async () => {
  await loadList()
  void loadModelStatus()
  const q = Number(route.query.requestId)
  if (q) void select(q)
})

const selectedItem = computed(() => items.value.find((i) => i.requestId === selectedId.value) ?? null)
const latestRun = computed(() => {
  const runs = detail.value?.runs ?? []
  return runs.length ? runs[runs.length - 1] : null
})

async function select(id: number) {
  if (!(checked.value.length === 1 && checked.value[0] === id)) checked.value = [id]
  selectedId.value = id
  detail.value = null
  impacts.value = null
  reGate.value = null
  try {
    detail.value = await api.historyDetail(id)
    const item = items.value.find((i) => i.requestId === id)
    const runId = latestRun.value?.runId ?? item?.latestRunId
    if (runId && (item?.evidenceChanged || latestRun.value?.evidenceChanged)) impacts.value = await api.impacts(runId).catch(() => [])
  } catch (e) {
    if (e instanceof GateApiError) reGate.value = toGateView(e.body)
  }
}
watch(() => route.query.requestId, (q) => q && void select(Number(q)))

// 체크박스 — 정확히 하나일 때만 자세히 보기를 연다
const allChecked = computed(() => items.value.length > 0 && checked.value.length === items.value.length)
function toggleAll(on: boolean) {
  checked.value = on ? items.value.map((i) => i.requestId!) : []
}
watch(checked, (ids) => {
  if (ids.length === 1) {
    if (selectedId.value !== ids[0]) void select(ids[0]!)
  } else {
    selectedId.value = null
    detail.value = null
    impacts.value = null
  }
})
const checkedNames = computed(() => items.value.filter((i) => checked.value.includes(i.requestId!)).map((i) => i.displayName).join(', '))

const changed = computed(() => !!(selectedItem.value?.evidenceChanged || latestRun.value?.evidenceChanged))

const railSteps = computed<RailStep[]>(() => [
  { label: '기록 보기', state: selectedId.value ? 'done' : 'now' },
  { label: '바뀐 근거 확인', state: selectedId.value ? (changed.value ? 'done' : 'wait') : 'wait' },
  reGate.value ? { label: '다시 분석', state: 'block', gate: reGate.value.gate } : { label: '다시 분석', state: selectedId.value ? 'now' : 'wait' },
  { label: '새 결과', state: 'wait' },
])

const reReason = computed<DisabledReason | null>(() => {
  if (reGate.value) return { gate: reGate.value.gate, text: reGate.value.title }
  if (ms.value?.state === 'unreachable') return { gate: 'G5', text: '지금은 분석할 수 없어요' }
  if (checked.value.length > 1) return { text: '다시 분석은 기록을 하나만 골랐을 때 할 수 있어요' }
  if (!selectedId.value) return { text: '다시 분석할 기록을 골라 주세요' }
  if (!latestRun.value && !selectedItem.value?.latestRunId) return { text: '기록을 불러오고 있어요' }
  return null
})
const g5Shown = computed(() =>
  reGate.value ?? (ms.value?.state === 'unreachable' ? gateFromCode('G5', { reason: '분석 서버가 응답하지 않습니다. 기존 결과는 그대로 볼 수 있습니다' }) : null),
)

async function reanalyze() {
  const id = selectedId.value
  const prev = latestRun.value?.runId ?? selectedItem.value?.latestRunId
  if (!id || !prev) return
  reBusy.value = true
  reFailed.value = false
  try {
    const r = await api.reanalyze(id, prev)
    router.push({ path: `/analyses/${id}/detection`, query: r.runId ? { run: String(r.runId) } : {} })
  } catch (e) {
    if (e instanceof GateApiError) reGate.value = toGateView(e.body)
    else reFailed.value = true
  } finally {
    reBusy.value = false
  }
}

async function doDelete() {
  const ids = [...checked.value]
  if (!ids.length) return
  deleting.value = true
  delFailed.value = false
  try {
    for (const id of ids) {
      await api.deleteHistory(id)
      items.value = items.value.filter((i) => i.requestId !== id)
      checked.value = checked.value.filter((x) => x !== id)
    }
    selectedId.value = null
    detail.value = null
    delOpen.value = false
  } catch {
    delFailed.value = true
  } finally {
    deleting.value = false
  }
}

function onGate(a: string) {
  if (a === 'recheck_status' || a.includes('status')) void loadModelStatus()
  else if (a.includes('history')) router.push('/history')
  else router.push('/')
}
// 문서 이름을 누르면 그 줄 아래가 부드럽게 열린다(2026-10-01) — 체크박스 · 다시 분석과는 따로(그쪽 상태를 바꾸지 않는다)
const openRow = ref<number | null>(null)
const rowInfo = ref<Record<number, { detail: HistoryDetail | null; result: ResultView | null; done: boolean }>>({})
async function toggleRow(i: HistoryItem) {
  const id = i.requestId!
  openRow.value = openRow.value === id ? null : id
  if (openRow.value !== id || rowInfo.value[id]) return
  rowInfo.value = { ...rowInfo.value, [id]: { detail: null, result: null, done: false } }
  const [d, r] = await Promise.all([
    api.historyDetail(id).catch(() => null),
    i.latestRunId ? api.result(i.latestRunId).catch(() => null) : Promise.resolve(null),
  ])
  rowInfo.value = { ...rowInfo.value, [id]: { detail: d, result: r, done: true } }
}
function topRisks(r: ResultView | null) {
  if (!r) return []
  const byId = new Map(r.clauses.map((c) => [c.assessmentId, c]))
  const order = r.riskOrder?.length ? r.riskOrder.map((x) => byId.get(x)).filter((c): c is NonNullable<typeof c> => !!c) : r.clauses.filter((c) => c.displayCategory !== 'normal')
  return order.slice(0, 3).map((c) => ({
    id: c.assessmentId,
    level: c.riskLevel ?? null,
    label: [c.articleNo, c.paragraphNo, c.title].filter(Boolean).join(' ') || `조항 ${c.seq}`,
    text: c.text.length > 70 ? `${c.text.slice(0, 70)}…` : c.text,
  }))
}
function counts(i: HistoryItem) {
  const c = i.counts ?? {}
  return `높음 ${c.high ?? 0} · 중간 ${c.mid ?? 0} · 낮음 ${c.low ?? 0}`
}
</script>

<template>
  <div class="page">
    <div v-if="accessGate" class="section tight">
      <C2GateBlock :gate="accessGate" full @action="onGate" />
    </div>
    <template v-else>
      <C1Rail :steps="railSteps" />
      <div class="page-head">
        <h1 class="t-display-lg">분석 기록</h1>
        <p class="lede">지금까지 분석한 계약서예요. 왼쪽 칸을 체크해서 골라 주세요. 근거 자료(법령 · 사례)가 바뀐 기록은 다시 분석해 볼 수 있어요.</p>
        <div class="row">
          <C11ModelServerState v-if="ms && ms.state !== 'ready'" :status="ms" :loading="msLoading" :failed="msFailed" @refresh="loadModelStatus" />
        </div>
      </div>

      <section class="section tight">
        <C7AreaPlaceholder v-if="!loading && !listFailed && !items.length" kind="na" text="아직 분석한 계약서가 없어요">
          <p class="mt-md"><RouterLink to="/">새 분석 시작</RouterLink></p>
        </C7AreaPlaceholder>
        <C7AreaPlaceholder v-else-if="listFailed" kind="unavailable" text="기록을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요" />
        <div v-else class="tablewrap">
          <table class="spec" data-part="history-table">
            <thead>
              <tr>
                <th class="check-col"><input type="checkbox" :checked="allChecked" :indeterminate="checked.length > 0 && !allChecked" aria-label="모두 고르기" data-action="check-all" @change="toggleAll(($event.target as HTMLInputElement).checked)" /></th>
                <th>문서</th><th>분석일</th><th>보는 입장</th><th>근거 자료 기준일</th><th>위험도 요약</th><th>근거 변경</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="i in items" :key="i.requestId">
              <tr :aria-selected="checked.includes(i.requestId!) ? 'true' : undefined" :class="{ 'row-open': openRow === i.requestId }">
                <td class="check-col"><input v-model="checked" type="checkbox" :value="i.requestId" :aria-label="`${i.displayName} 고르기`" data-part="row-check" /></td>
                <td>
                  <button type="button" class="doc-toggle" :aria-expanded="openRow === i.requestId ? 'true' : 'false'" :aria-controls="`row-${i.requestId}`" data-part="row-toggle" @click="toggleRow(i)">
                    <span class="doc-caret" aria-hidden="true">›</span><span class="doc-name">{{ i.displayName }}</span>
                  </button>
                </td>
                <td>{{ ymd(i.requestedAt) }}</td>
                <td>{{ i.perspective ? PERSPECTIVE[i.perspective] : '' }}</td>
                <td>{{ ymd(i.knowledgeDate) }}</td>
                <td>
                  <span class="mini-counts">
                    <span class="risk sm high" :title="`위험도 높음 ${i.counts?.high ?? 0}`">{{ i.counts?.high ?? 0 }}</span><span class="risk sm mid" :title="`위험도 중간 ${i.counts?.mid ?? 0}`">{{ i.counts?.mid ?? 0 }}</span><span class="risk sm low" :title="`위험도 낮음 ${i.counts?.low ?? 0}`">{{ i.counts?.low ?? 0 }}</span>
                    <span class="visually-hidden">{{ counts(i) }}</span>
                  </span>
                </td>
                <td><strong v-if="i.evidenceChanged">바뀜</strong><span v-else class="muted">없음</span></td>
              </tr>
              <tr :id="`row-${i.requestId}`" :class="['row-expand', { open: openRow === i.requestId }]" data-part="row-expand">
                <td colspan="7">
                  <div :class="['grow', { open: openRow === i.requestId }]" :inert="openRow !== i.requestId || undefined">
                    <div class="grow-inner">
                      <div v-if="rowInfo[i.requestId!]" class="row-panel">
                        <p v-if="!rowInfo[i.requestId!].done" class="t-body-sm muted m-0">내용을 불러오고 있어요…</p>
                        <template v-else>
                          <div class="row-panel-main">
                            <p class="rp-label">계약 요약</p>
                            <p class="t-body-sm m-0">{{ rowInfo[i.requestId!].result?.documents?.[0]?.summary || '요약이 없어요. 결과 화면에서 조항별 판단을 확인해 주세요' }}</p>
                            <p v-if="rowInfo[i.requestId!].result" class="t-caption-sm muted m-0 mt-xs">
                              조항 <b>{{ rowInfo[i.requestId!].result!.clauses.length }}개</b><template v-if="rowInfo[i.requestId!].result!.documents?.[0]?.contractType"> · {{ CONTRACT_TYPE[rowInfo[i.requestId!].result!.documents![0].contractType!] }}</template>
                            </p>
                            <template v-if="topRisks(rowInfo[i.requestId!].result).length">
                              <p class="rp-label mt-md">가장 위험한 조항</p>
                              <ul class="rp-risks">
                                <li v-for="x in topRisks(rowInfo[i.requestId!].result)" :key="x.id">
                                  <span v-if="x.level" :class="['risk', 'sm', x.level]">{{ RISK_LEVEL[x.level] }}</span>
                                  <span class="rp-risk-text"><b>{{ x.label }}</b> <C8Masked :text="x.text" /></span>
                                </li>
                              </ul>
                            </template>
                          </div>
                          <div class="row-panel-side">
                            <p class="rp-label">분석한 기록</p>
                            <ul class="rp-runs">
                              <li v-for="run in rowInfo[i.requestId!].detail?.runs ?? []" :key="run.runId">
                                <span>{{ run.runKind === 'reanalysis' ? '다시 분석' : '처음 분석' }} · {{ ymdhm(run.savedAt) }}</span>
                                <RouterLink :to="{ path: `/results/${run.runId}`, query: { from: 'history' } }">결과 열기</RouterLink>
                              </li>
                            </ul>
                            <RouterLink v-if="i.latestRunId" :to="{ path: `/results/${i.latestRunId}`, query: { from: 'history' } }" class="btn btn-primary mt-md">최근 결과 자세히 보기</RouterLink>
                          </div>
                        </template>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p v-if="loading" class="t-body-sm muted">불러오고 있어요…</p>
        <button v-if="nextCursor" type="button" class="btn btn-secondary mt-lg" @click="loadList(true)">더 보기</button>
      </section>

      <section v-if="checked.length > 1" class="section tight card strong" data-part="multi-selected">
        <h2 class="t-heading-sm">{{ checked.length }}건을 골랐어요</h2>
        <p class="t-body-sm charcoal m-0 mt-xs">{{ checkedNames }}</p>
        <div class="row mt-lg">
          <button type="button" class="btn btn-secondary" data-action="delete" @click="delOpen = true">고른 기록 {{ checked.length }}건 삭제</button>
          <button type="button" class="btn btn-text" @click="checked = []">고르기 취소</button>
        </div>
      </section>

      <section v-if="selectedId" class="section tight card strong" aria-labelledby="sel-h" data-part="selected">
        <h2 id="sel-h" class="t-heading-sm">{{ detail?.displayName ?? selectedItem?.displayName }}<template v-if="changed"> · 분석한 뒤에 근거 자료가 바뀌었어요</template></h2>
        <div v-if="changed" class="tablewrap mt-md">
          <C7AreaPlaceholder v-if="impacts && !impacts.length" kind="na" text="바뀐 내용이 없어요" />
          <table v-else-if="impacts" class="spec">
            <thead><tr><th>바뀐 내용</th><th>근거</th><th>근거 자료 기준일</th></tr></thead>
            <tbody>
              <tr v-for="(x, k) in impacts" :key="k"><td>{{ CHANGE_KIND[x.changeKind ?? ''] ?? x.changeKind }}</td><td>{{ evidenceName(x.sourceName, x.identifier) }}</td><td>{{ ymd(x.knowledgeDate) }}</td></tr>
            </tbody>
          </table>
          <C7AreaPlaceholder v-else kind="processing" text="바뀐 내용을 불러오고 있어요" />
        </div>
        <ul v-if="detail?.runs?.length" class="bullets mt-md">
          <li v-for="run in detail.runs" :key="run.runId">
            {{ run.runKind === 'reanalysis' ? '다시 분석' : '처음 분석' }} · 근거 자료 기준일 {{ ymd(run.knowledgeDate) }} · 저장 {{ ymdhm(run.savedAt) }}
            <template v-if="run.prevRunId"> · 이전 결과와 비교</template>
            · <RouterLink :to="{ path: `/results/${run.runId}`, query: { from: 'history' } }">당시 결과 열기</RouterLink>
          </li>
        </ul>
        <div class="row mt-lg">
          <RouterLink
            v-if="latestRun || selectedItem?.latestRunId"
            :to="{ path: `/results/${latestRun?.runId ?? selectedItem?.latestRunId}`, query: { from: 'history' } }"
            class="btn btn-secondary"
          >
            당시 결과 열기
          </RouterLink>
          <button type="button" class="btn btn-secondary" data-action="delete" @click="delOpen = true">기록 삭제</button>
        </div>
      </section>

      <section v-if="g5Shown" class="section tight">
        <C2GateBlock :gate="g5Shown" :busy-action="msLoading ? 'recheck_status' : null" @action="onGate" />
      </section>

      <section class="section tight">
        <C3ReasonButton label="다시 분석" primary :reason="reReason" :busy="reBusy" busy-label="다시 분석을 시작하고 있어요…" @click="reanalyze" />
        <p class="t-caption-sm muted mt-sm">가장 최근 근거 자료로 다시 판단해요. 지난 기록은 그대로 두고 새 결과를 더해요.</p>
        <p v-if="reFailed" role="alert" class="t-body-sm">다시 분석을 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.</p>
      </section>

      <DeleteConfirm :open="delOpen" :busy="deleting" :failed="delFailed" :name="checkedNames" @confirm="doDelete" @cancel="delOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.check-col { width: 44px; }
/* 문서 펼치기(2026-10-01) — grid-template-rows 0fr → 1fr 로 높이를 부드럽게(0.36초 감속 곡선), 닫힌 줄은 높이 0 · 화면 읽기 제외 */
.doc-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 4px 0; border: 0; background: transparent; color: var(--color-ink); font: 600 14px/1.4 var(--font-sans); text-align: left; cursor: pointer; }
.doc-toggle:hover .doc-name { text-decoration: underline; text-underline-offset: 3px; }
.doc-caret { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: var(--rounded-full); background: var(--color-surface-soft); font-size: 14px; transition: transform .3s cubic-bezier(.22, 1, .36, 1); }
.doc-toggle[aria-expanded="true"] .doc-caret { transform: rotate(90deg); background: var(--color-ink); color: var(--color-on-primary); }
tr.row-open > td { border-bottom-color: transparent; background: var(--color-paper); }
.row-expand > td { padding: 0 !important; border-bottom: 0 !important; }
.row-expand.open > td { border-bottom: 1px solid var(--color-hairline) !important; background: var(--color-paper); }
.grow { display: grid; grid-template-rows: 0fr; opacity: 0; visibility: hidden; transition: grid-template-rows .36s cubic-bezier(.22, 1, .36, 1), opacity .24s ease-out, visibility 0s linear .36s; }
.grow.open { grid-template-rows: 1fr; opacity: 1; visibility: visible; transition: grid-template-rows .36s cubic-bezier(.22, 1, .36, 1), opacity .3s ease-out .05s, visibility 0s; }
.grow-inner { min-height: 0; overflow: hidden; }
.row-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 300px); gap: var(--spacing-xl); padding: var(--spacing-lg) var(--spacing-lg) var(--spacing-xl) 56px; }
.rp-label { margin: 0 0 4px; font: 600 12px/1.4 var(--font-sans); color: var(--color-body); }
.rp-risks, .rp-runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.rp-risks li { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.rp-risk-text { font: 400 13px/1.5 var(--font-sans); min-width: 0; }
.rp-runs li { display: flex; justify-content: space-between; gap: var(--spacing-md); font: 400 13px/1.5 var(--font-sans); }
.mini-counts { position: relative; display: inline-flex; gap: 4px; } /* relative — 안의 화면 읽기용 글(absolute)이 표 스크롤 칸 밖으로 새어 페이지가 옆으로 밀리지 않게 */
.mini-counts .risk.sm { min-width: 30px; justify-content: center; font-variant-numeric: tabular-nums; }
/* 휴대폰 — 표는 옆으로 밀리지만 펼친 내용은 화면 폭에 붙여 둔다(잘리지 않게) */
@media (max-width: 760px) { .row-panel { grid-template-columns: 1fr; padding-left: var(--spacing-md); position: sticky; left: 0; width: calc(100vw - 32px); box-sizing: border-box; } }
@media (prefers-reduced-motion: reduce) { .grow, .grow.open, .doc-caret { transition: none; } }
.check-col input { width: 18px; height: 18px; cursor: pointer; }
</style>
