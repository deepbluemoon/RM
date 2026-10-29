<script setup lang="ts">
// S7-O 탐지 품질 평가 — 운영자 뷰 (SD_02 §11) — T137. 주 CTA = "평가 시작"(채운 검정 버튼 1개). 배포 차단 조작 없음(경고만).
// 공유 모델 서버는 한 번에 1건씩 판정하므로 일괄 추론이 길다 — 진행 레일 아래에 경과 시간·진행 건수·남은 시간을 보인다.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { toGateView, type GateView } from '@/lib/gates'
import { CONTRACT_TYPE, MODEL_NAME } from '@/lib/labels'
import { approxDuration, ymd, ymdhm } from '@/lib/format'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import ProgressWaitLine from '@/components/common/ProgressWaitLine.vue'
import EvalRegisterPanel, { type EvalCandidateRow } from '@/components/eval/EvalRegisterPanel.vue'
import EvalCompareTable, { type CompareResult } from '@/components/eval/EvalCompareTable.vue'
import { vSmoothDetails } from '@/lib/smoothDetails' // 등록 칸 펼치기 부드럽게(2026-10-01)
import type { ContractType, EvalMetric, EvalOverview, EvalRun } from '@/api/types'

// 계약의 EvalRun·overview 는 additionalProperties 를 허용한다 — 서버가 더 싣는 진행·성공 기준 필드
interface RunProgress {
  phase: 'queued' | 'detecting' | 'judging' | 'done' | 'aborted'
  total: number
  done: number
  timedOut: number
  judgeTotal: number | null
  judgeDone: number | null
  avgJudgeSec: number | null
  etaSec: number | null
  sharedModelQueue: number
  startedAt: string
  elapsedSec: number | null
}
interface Criterion { code: string; label: string; target: string; status: 'met' | 'below' | 'pending' | 'unmeasurable'; below: string[]; gapPp?: number | null }
type Metric = EvalMetric & { contractTypeLabel?: string; reviewPending?: number }
type RunView = Omit<EvalRun, 'metrics'> & {
  knowledgeDate?: string
  analysisBasisVersion?: string
  progress?: RunProgress
  criteria?: Criterion[]
  reviews?: { total: number; pending: number }
  recordedAt?: string | null
  metrics?: Metric[]
}
interface RunRow { evalRunId: number; stage: string; startedAt?: string; recordedAt?: string; scConfirmedAt?: string; m3?: string; knowledgeDate?: string }
type Overview = EvalOverview & { modelServer?: 'ready' | 'unreachable'; candidates?: EvalCandidateRow[]; runs?: RunRow[] }

const route = useRoute()
const router = useRouter()
const overview = ref<Overview | null>(null)
const runId = ref<number | null>(Number(route.query.run) || null)
const run = ref<RunView | null>(null)
const pageGate = ref<GateView | null>(null)
const actionGate = ref<GateView | null>(null)
const busy = ref<string | null>(null)
const msg = ref<string | null>(null)
const cmpA = ref<number | null>(null)
const cmpB = ref<number | null>(null)
const cmp = ref<CompareResult | null>(null)
const cmpMsg = ref<string | null>(null)
const registerOpen = ref(false)
const fetchedAt = ref(Date.now())
const now = ref(Date.now())
let timer: ReturnType<typeof setTimeout> | null = null
let ticker: ReturnType<typeof setInterval> | null = null

const STAGE_TEXT: Record<string, string> = {
  eligibility: '평가 대상 확인', inferring: '모델 실행 중', awaiting_expert: '전문가 근거 검토 대기', result: '결과 확인', recorded: '기록됨', aborted: '중단됨',
}
const running = computed(() => run.value?.stage === 'eligibility' || run.value?.stage === 'inferring')

async function loadOverview() {
  try {
    overview.value = await api.evalOverview()
    const rec = overview.value.recordedRuns ?? []
    if (cmpA.value == null && rec.length >= 2) {
      cmpB.value = rec[0]!.evalRunId
      cmpA.value = rec[1]!.evalRunId
    }
  } catch (e) {
    if (e instanceof GateApiError) pageGate.value = toGateView(e.body)
  }
}
async function loadRun() {
  if (timer) clearTimeout(timer)
  timer = null
  if (!runId.value) return
  try {
    run.value = (await api.evalRun(runId.value)) as RunView
    fetchedAt.value = Date.now()
    // 추론은 백그라운드 작업 — 끝날 때까지 3초마다 다시 읽는다(요청을 막지 않음)
    if (running.value) timer = setTimeout(loadRun, 3000)
    else if (run.value.stage !== 'eligibility') void loadOverview()
  } catch (e) {
    if (e instanceof GateApiError) actionGate.value = toGateView(e.body)
  }
}
onMounted(async () => {
  ticker = setInterval(() => (now.value = Date.now()), 1000)
  await loadOverview()
  await loadRun()
})
onUnmounted(() => {
  if (timer) clearTimeout(timer)
  if (ticker) clearInterval(ticker)
})

function openRun(id: number) {
  runId.value = id
  actionGate.value = null
  msg.value = null
  router.replace({ query: { run: String(id) } })
  void loadRun()
}

// ---------------------------------------------------------------- 레일·진행
const gates = computed(() => (run.value?.openGates ?? []).map((g) => toGateView(g)))
const g5 = computed(() => (actionGate.value?.gate === 'G5' ? actionGate.value : gates.value.find((g) => g.gate === 'G5') ?? null))
const STAGE_IDX: Record<string, number> = { eligibility: 1, inferring: 2, awaiting_expert: 3, result: 4, recorded: 6, aborted: 2 }
const railSteps = computed<RailStep[]>(() => {
  const labels = ['평가 데이터·버전', '평가 대상 확인', '모델 한꺼번에 실행', '근거가 맞는지 검토', '결과 확인', '기록']
  const stage = run.value?.stage ?? ''
  const idx = run.value ? (STAGE_IDX[stage] ?? 0) : 0
  const pending = (run.value?.reviews?.pending ?? 0) > 0
  return labels.map((label, i) => {
    if (i === 2 && (stage === 'aborted' || g5.value)) return { label, state: 'block', gate: 'G5' }
    if (i === 3 && pending && idx >= 3) return { label, state: 'hold', gate: 'G11' }
    return { label, state: i < idx ? 'done' : i === idx ? 'now' : 'wait' }
  })
})
const elapsed = computed(() => {
  const p = run.value?.progress
  if (!p || p.elapsedSec == null || !running.value) return null
  return p.elapsedSec + Math.max(0, Math.floor((now.value - fetchedAt.value) / 1000))
})
const progressText = computed(() => {
  const p = run.value?.progress
  if (!p) return ''
  const parts = [`조항 ${p.total}개 중 ${p.done}개 모델 실행 완료`]
  if (p.phase === 'queued') parts.push('차례 기다리는 중')
  if (p.phase === 'detecting') parts.push('편법·위법 탐지 모델(M1·M2) 점수 계산 중')
  if (p.phase === 'judging' && p.judgeTotal != null) parts.push(`최종 판단 모델(M3) 판단 ${p.judgeDone ?? 0}/${p.judgeTotal}`)
  if (p.etaSec != null) parts.push(`남은 시간 ${approxDuration(Math.max(0, p.etaSec - Math.floor((now.value - fetchedAt.value) / 1000)))}`)
  else if (p.phase === 'judging') parts.push('남은 시간 계산 중(첫 판단이 끝나면 표시)')
  if (p.avgJudgeSec != null) parts.push(`판단 1건에 평균 ${p.avgJudgeSec}초`)
  if (p.sharedModelQueue > 0) parts.push(`공유 모델 서버에서 앞선 요청 ${p.sharedModelQueue}건 대기`)
  return parts.join(' · ')
})

// ---------------------------------------------------------------- 조작
async function startRun() {
  busy.value = 'start'
  actionGate.value = null
  msg.value = null
  try {
    const r = await api.startEvalRun()
    if (r.evalRunId) openRun(r.evalRunId)
  } catch (e) {
    if (e instanceof GateApiError) actionGate.value = toGateView(e.body, e.gate === 'G5' ? { nextActions: [{ id: 'server_status', label: '모델 서버 상태 확인' }] } : {})
    else msg.value = '평가를 시작하지 못했습니다 - 평가 데이터를 확인한 뒤 다시 시도하세요'
  } finally {
    busy.value = null
  }
}
async function record() {
  if (!runId.value) return
  busy.value = 'record'
  try {
    await api.recordEvalRun(runId.value)
    msg.value = `평가 결과를 기록했습니다(EV-${runId.value}${(run.value?.reviews?.pending ?? 0) > 0 ? ', 전문가 검토가 끝나지 않은 항목 포함' : ''})`
    await loadRun()
  } catch (e) {
    if (e instanceof GateApiError) actionGate.value = toGateView(e.body)
    else msg.value = '기록하지 못했습니다 - 다시 시도하세요'
  } finally {
    busy.value = null
  }
}
async function confirm() {
  if (!runId.value) return
  busy.value = 'confirm'
  try {
    await api.confirmEvalRun(runId.value)
    msg.value = '성공 기준 결과를 확정했습니다'
    await loadRun()
  } catch (e) {
    if (e instanceof GateApiError) actionGate.value = toGateView(e.body)
    else msg.value = '확정하지 못했습니다 - 다시 시도하세요'
  } finally {
    busy.value = null
  }
}
async function compare() {
  cmp.value = null
  cmpMsg.value = null
  if (!cmpA.value || !cmpB.value || cmpA.value === cmpB.value) {
    cmpMsg.value = '기록해 둔 평가 가운데 서로 다른 두 개를 고르세요'
    return
  }
  try {
    cmp.value = (await api.compareEval(cmpA.value, cmpB.value)) as unknown as CompareResult
  } catch {
    cmpMsg.value = '비교하지 못했습니다 - 기록해 둔 평가끼리만 비교할 수 있습니다'
  }
}

const startReason = computed<DisabledReason | null>(() => {
  if (g5.value && !run.value) return { gate: 'G5', text: '지금은 모델을 쓸 수 없음' }
  if (overview.value?.modelServer === 'unreachable') return { gate: 'G5', text: '모델 서버가 응답하지 않음' }
  if (running.value) return { text: '이미 평가가 진행 중입니다' }
  if (!overview.value?.acceptedByType?.length) return { text: '전문가 검토를 마친 평가 데이터가 없습니다' }
  return null
})
const confirmReason = computed<DisabledReason | null>(() => {
  if (!run.value) return { text: '평가 결과가 없습니다' }
  if (run.value.scConfirmedAt) return { text: '이미 확정했습니다' }
  if (run.value.stage === 'aborted') return { text: '중단된 평가입니다' }
  if (running.value) return { text: '점수 계산이 끝나야 확정할 수 있습니다' }
  const blockers = [...new Set(gates.value.filter((g) => g.gate === 'G11' || g.gate === 'G12').map((g) => g.gate))]
  if (blockers.length) return { gate: blockers.join(' · '), text: blockers.map((b) => (b === 'G11' ? '전문가 검토 대기' : '측정할 수 없음')).join(' · ') }
  if (!run.value.confirmable) return { text: '확정할 수 있는 조건을 채우지 못했습니다' }
  return null
})
const recordReason = computed<DisabledReason | null>(() => {
  if (!run.value) return { text: '평가 결과가 없습니다' }
  if (run.value.stage === 'aborted') return { gate: 'G5', text: '중단된 평가는 기록하지 않습니다' }
  if (run.value.stage === 'recorded') return { text: '이미 기록했습니다' }
  if (running.value) return { text: '점수 계산이 끝나면 기록할 수 있습니다' }
  return null
})

// ---------------------------------------------------------------- 표시
const typeLabel = (m: Metric) => m.contractTypeLabel ?? CONTRACT_TYPE[m.contractType as ContractType] ?? m.contractType
function pct(v: number | null | undefined, m: Metric, kind: 'fit' | 'other') {
  if (m.measurable !== true) return '측정할 수 없음'
  if (v == null) return kind === 'fit' ? ((m.reviewPending ?? 0) > 0 || (run.value?.reviews?.pending ?? 0) > 0 ? '전문가 검토 대기' : '검토한 표본 없음') : '해당 없음'
  return `${Math.round(v * 10) / 10}%`
}
const unmeasurable = computed(() => (run.value?.metrics ?? []).filter((m) => m.measurable !== true))
const CRIT_TEXT: Record<Criterion['status'], string> = { met: '✓ 기준 충족', below: '△ 기준 미달(경고)', pending: '… 전문가 검토 대기', unmeasurable: '— 측정할 수 없음' }
function critText(c: Criterion) {
  if (c.status === 'below') return c.code === 'SC-007' ? `${CRIT_TEXT.below} - 계약 유형 간 차이 ${c.gapPp ?? ''}%p` : `${CRIT_TEXT.below} - ${c.below.join('·')} 기준에 못 미침`
  if (c.code === 'SC-007' && c.status === 'met') return `${CRIT_TEXT.met} (${c.gapPp}%p)`
  return CRIT_TEXT[c.status]
}
const exTotal = computed(() => {
  const x = run.value?.excluded
  return (x?.unreviewed ?? 0) + (x?.synthetic ?? 0) + (x?.trainingOverlap ?? 0)
})
const versions = computed(() => run.value?.modelVersions ?? overview.value?.modelVersions ?? {})
const trained = computed(() => overview.value?.trainedDataDates ?? {})

function onGate(a: string) {
  if (a === 'server_status' || a === 'recheck_status') router.push('/admin/model-api')
  else if (a === 'request_review') router.push('/admin/eval/expert')
  else if (a === 'request_verdict' || a === 'request_expert') router.push({ path: '/admin/eval/expert', query: { run: String(runId.value ?? ''), tab: 'fit' } })
  else if (a === 'register_eval_data' || a === 'register_eval_items') {
    registerOpen.value = true
    document.getElementById('register')?.scrollIntoView?.({ block: 'start' })
  }
}
</script>

<template>
  <div class="page">
    <div v-if="pageGate" class="section tight"><C2GateBlock :gate="pageGate" full @action="router.push('/')" /></div>
    <template v-else>
      <C1Rail :label="`품질 점검${runId ? ` · EV-${runId}` : ''}`" :steps="railSteps">
        <ProgressWaitLine
          v-if="run && running"
          :elapsed-sec="elapsed"
          :expected="progressText || '모델 실행 준비 중'"
        />
      </C1Rail>
      <div class="page-head">
        <h1 class="t-display-lg">품질 점검</h1>
        <p class="t-body-sm charcoal">근거 자료나 모델이 바뀐 뒤, 위험 조항을 얼마나 잘 찾는지 전문가 검토를 마친 평가 데이터로 확인하는 화면입니다. 운영자는 평가를 시작하고, 계약 유형별 점수와 성공 기준을 본 뒤 결과를 기록하고 성공 기준을 확정할지 결정합니다.</p>
        <div class="band" role="note" data-part="versions">
          <span>근거 자료 기준일 <strong>{{ ymd(run?.knowledgeDate ?? overview?.knowledgeDate) || '확인 중' }}</strong></span>
          <span v-if="run?.analysisBasisVersion ?? overview?.analysisBasisVersion">분석 기준 버전 {{ run?.analysisBasisVersion ?? overview?.analysisBasisVersion }}</span>
          <span v-for="k in (['m1', 'm2', 'm3'] as const)" :key="k" class="mono">
            {{ k.toUpperCase() }} {{ MODEL_NAME[k.toUpperCase()] }} {{ versions[k] ?? '확인 불가' }}<template v-if="trained[k]"> · 학습 기준일 {{ ymd(trained[k]) }}</template>
          </span>
        </div>
        <p v-if="overview?.modelServer === 'unreachable'" class="t-body-sm">모델 서버가 응답하지 않아 지금 쓰는 모델 버전을 확인할 수 없습니다. 모델 서버 상태를 먼저 확인하세요.</p>
        <p v-if="msg" role="status" class="t-body-sm">{{ msg }}</p>
      </div>

      <section class="section tight card stack sm" aria-labelledby="data-h">
        <h2 id="data-h" class="t-heading-sm">평가 데이터 - 전문가 검토 완료</h2>
        <C7AreaPlaceholder v-if="!overview?.acceptedByType?.length" kind="na" text="전문가 검토를 마친 평가 데이터가 없습니다 - 아래에서 평가 데이터를 등록하고 전문가 검토를 요청하세요" />
        <ul v-else class="bullets">
          <li v-for="t in overview.acceptedByType" :key="t.contractType">{{ CONTRACT_TYPE[t.contractType] }} {{ t.count }}건</li>
        </ul>
        <p class="t-body-sm charcoal">
          전문가 검토 대기 {{ overview?.pendingReviewCount ?? 0 }}건 · 이용자 의견에서 온 후보 {{ overview?.candidates?.length ?? 0 }}건 —
          <RouterLink to="/admin/eval/expert">전문가 검토 화면으로</RouterLink>
        </p>
        <details id="register" v-smooth-details :open="registerOpen" @toggle="registerOpen = ($event.target as HTMLDetailsElement).open">
          <summary class="t-body-sm-strong">평가 데이터 등록 - 정답을 새로 붙인 조항 · 이용자 의견에서 온 후보</summary>
          <EvalRegisterPanel :candidates="overview?.candidates ?? []" @registered="loadOverview" />
        </details>
      </section>

      <section v-if="g5" class="section tight"><C2GateBlock :gate="g5" @action="onGate" /></section>

      <template v-if="run">
        <section class="section tight card stack sm" aria-labelledby="elig-h">
          <h2 id="elig-h" class="t-heading-sm">평가 대상 조항 {{ run.progress?.total ?? 0 }}</h2>
          <p class="t-body-sm" data-part="excluded">
            평가에서 뺀 조항 {{ exTotal }} - 전문가 검토 안 끝남 {{ run.excluded?.unreviewed ?? 0 }} · 일부러 바꿔 만든 문장 {{ run.excluded?.synthetic ?? 0 }} · 모델 학습에 이미 쓴 문장 {{ run.excluded?.trainingOverlap ?? 0 }}
            · 시간 초과로 뺌 {{ run.progress?.timedOut ?? 0 }}
          </p>
          <C7AreaPlaceholder
            v-if="running"
            kind="processing"
            text="모델을 한꺼번에 실행하는 중 - 공유 모델 서버는 한 번에 1건씩 판단하므로 평가 규모에 따라 수십 분 걸릴 수 있습니다. 이 화면을 떠나도 평가는 계속됩니다"
          />
        </section>

        <section class="section tight" aria-labelledby="met-h">
          <h2 id="met-h" class="section-title">계약 유형별 점수</h2>
          <C7AreaPlaceholder v-if="running" kind="processing" text="점수 계산 중 - 모델 실행이 끝나면 표시됩니다" />
          <C7AreaPlaceholder v-else-if="!run.metrics?.length" kind="unavailable" text="점수를 낼 수 없음 - 평가한 조항이 없습니다" />
          <template v-else>
            <div class="tablewrap">
              <table class="spec" data-part="metrics">
                <thead><tr><th>계약 유형</th><th>조항 수</th><th>시간 초과로 뺌</th><th>재현율(위험 조항을 놓치지 않은 비율)</th><th>정밀도(위험이라고 한 것이 맞은 비율)</th><th>근거 적합률(근거가 맞게 붙은 비율)</th></tr></thead>
                <tbody>
                  <tr v-for="m in run.metrics" :key="m.contractType" :data-measurable="m.measurable === true ? 'yes' : 'no'">
                    <td>{{ typeLabel(m) }}</td>
                    <td>{{ m.clauseCount }}</td>
                    <td>{{ m.timeoutExcluded ?? 0 }}</td>
                    <td>{{ pct(m.recallPct, m, 'other') }}</td>
                    <td>{{ pct(m.precisionPct, m, 'other') }}</td>
                    <td>{{ pct(m.evidenceFitPct, m, 'fit') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <C7AreaPlaceholder
              v-if="unmeasurable.length"
              kind="unavailable"
              :text="`측정할 수 없음 - ${unmeasurable.map(typeLabel).join('·')}: 평가 조항이 부족해 점수를 내지 않습니다. 평가 데이터를 더 등록하세요`"
            />
          </template>
        </section>

        <section v-if="run.criteria?.length && !running" class="section tight" aria-labelledby="sc-h">
          <h2 id="sc-h" class="section-title">성공 기준</h2>
          <div class="tablewrap">
            <table class="spec" data-part="criteria">
              <thead><tr><th>기준</th><th>목표</th><th>이번 결과</th></tr></thead>
              <tbody>
                <tr v-for="c in run.criteria" :key="c.code"><td>{{ c.code }} {{ c.label }}</td><td>{{ c.target }}</td><td>{{ critText(c) }}</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="run.warnings?.length" class="section tight card" aria-labelledby="warn-h">
          <h2 id="warn-h" class="t-heading-sm">경고 - 참고용이며 배포를 막지는 않습니다</h2>
          <ul class="bullets">
            <li v-for="(w, i) in run.warnings" :key="i">{{ w.kind === 'bias_gap' ? '계약 유형 간 차이' : '기준 미달' }} - {{ w.message }}</li>
          </ul>
        </section>

        <section v-for="g in gates.filter((x) => x.gate !== 'G5')" :key="`${g.gate}-${g.title}`" class="section tight">
          <C2GateBlock :gate="g" :autofocus="false" @action="onGate" />
        </section>
        <section v-if="actionGate && actionGate.gate !== 'G5'" class="section tight"><C2GateBlock :gate="actionGate" @action="onGate" /></section>
        <p v-if="run.recordedAt || run.scConfirmedAt" class="t-body-sm charcoal">
          <template v-if="run.recordedAt">기록한 시각 {{ ymdhm(run.recordedAt) }}</template>
          <template v-if="run.scConfirmedAt"> · 성공 기준 확정한 시각 {{ ymdhm(run.scConfirmedAt) }}</template>
        </p>
      </template>

      <section class="section tight row">
        <C3ReasonButton label="평가 시작" primary :reason="startReason" :busy="busy === 'start'" @click="startRun" />
        <C3ReasonButton label="평가 결과 기록" :reason="recordReason" :busy="busy === 'record'" @click="record" />
        <C3ReasonButton label="성공 기준 확정" :reason="confirmReason" :busy="busy === 'confirm'" @click="confirm" />
      </section>

      <section v-if="overview?.runs?.length" class="section tight" aria-labelledby="runs-h">
        <h2 id="runs-h" class="section-title">최근 평가 목록</h2>
        <div class="tablewrap">
          <table class="spec" data-part="runs">
            <thead><tr><th>평가</th><th>상태</th><th>근거 자료 기준일</th><th>M3 최종 판단 모델</th><th>시작</th><th /></tr></thead>
            <tbody>
              <tr v-for="r in overview.runs" :key="r.evalRunId" :aria-current="r.evalRunId === runId ? 'true' : undefined">
                <td class="mono">EV-{{ r.evalRunId }}</td>
                <td>{{ STAGE_TEXT[r.stage] ?? r.stage }}<template v-if="r.scConfirmedAt"> · 확정</template></td>
                <td>{{ ymd(r.knowledgeDate) }}</td>
                <td class="mono">{{ r.m3 }}</td>
                <td>{{ ymdhm(r.startedAt) }}</td>
                <td><button type="button" class="btn btn-secondary" @click="openRun(r.evalRunId)">열기</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="section tight card stack sm" aria-labelledby="cmp-h">
        <h2 id="cmp-h" class="t-heading-sm">이전 평가와 비교 - 모델을 다시 돌리지 않음</h2>
        <C7AreaPlaceholder v-if="(overview?.recordedRuns?.length ?? 0) < 2" kind="na" text="기록해 둔 평가가 2건 이상이어야 비교할 수 있습니다" />
        <form v-else class="row" @submit.prevent="compare">
          <label class="t-body-sm">평가 A
            <select v-model.number="cmpA" class="text-input w-auto">
              <option v-for="r in overview?.recordedRuns ?? []" :key="r.evalRunId" :value="r.evalRunId">EV-{{ r.evalRunId }} · {{ ymd(r.knowledgeDate) }} · {{ r.m3 }}</option>
            </select>
          </label>
          <label class="t-body-sm">평가 B
            <select v-model.number="cmpB" class="text-input w-auto">
              <option v-for="r in overview?.recordedRuns ?? []" :key="r.evalRunId" :value="r.evalRunId">EV-{{ r.evalRunId }} · {{ ymd(r.knowledgeDate) }} · {{ r.m3 }}</option>
            </select>
          </label>
          <button type="submit" class="btn btn-secondary">비교하기</button>
        </form>
        <p v-if="cmpMsg" role="status" class="t-body-sm">{{ cmpMsg }}</p>
        <EvalCompareTable v-if="cmp" :result="cmp" />
      </section>
    </template>
  </div>
</template>
