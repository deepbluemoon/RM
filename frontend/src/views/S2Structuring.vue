<script setup lang="ts">
// S2 비식별화·구조화·계약 유형 확인 (SD_02 §6) — T084.
// 2026-09-30: 계약 유형은 요약 모델이 예측한 후보로 고정한다(사용자가 고르지 않음). 후보가 없으면 '일반 소비자 거래'.
// 예측이 오면 곧바로 상자에 보이고, 처리가 끝나면(유형 확정 가능) 자동으로 확정해 다음 화면(위험 찾기)으로 넘어간다. 실패하면 버튼으로 다시 시도.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAnalysisStore } from '@/stores/analysis'
import { CONTRACT_TYPE, PERSPECTIVE } from '@/lib/labels'
import { ymd } from '@/lib/format'
import { EXPECTED_TEXT } from '@/composables/progress'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import CancelAnalysisDialog from '@/components/common/CancelAnalysisDialog.vue'
import ProgressMeter from '@/components/common/ProgressMeter.vue'
import ProgressWaitLine from '@/components/common/ProgressWaitLine.vue'
import type { ContractType } from '@/api/types'

const props = defineProps<{ requestId: string }>()
const store = useAnalysisStore()
const router = useRouter()
const id = computed(() => Number(props.requestId))
const choice = ref<Record<number, ContractType | ''>>({})
const cancelOpen = ref(false)

onMounted(() => store.start(id.value))
onUnmounted(() => store.stop())
watch(id, (v) => store.start(v))

const s = computed(() => store.status)
watch(
  () => [store.phase, store.cancelled, store.blockingGate] as const,
  ([phase, cancelled, gate]) => {
    if (phase === 'detection' && !cancelled && !gate) router.replace(`/analyses/${id.value}/detection`)
  },
)
// 예측 후보로 고정한다. 문서는 요약(M4)보다 먼저 보이므로 — 실모델은 적재·생성에 수 초가 걸린다 — 후보가 오면 채우고,
// 요약이 실패해 후보가 없으면 '일반 소비자 거래'로 둔다
const FALLBACK_TYPE: ContractType = 'general_consumer'
watch(
  () => s.value?.documents,
  (docs) => {
    for (const d of docs ?? []) {
      if (d.documentId == null) continue
      const t = d.contractType ?? d.contractTypeCandidate ?? (d.summaryStatus === 'unavailable' ? FALLBACK_TYPE : '')
      choice.value[d.documentId] = t as ContractType | ''
    }
  },
  { immediate: true, deep: true },
)

const g6 = computed(() => (store.blockingGate?.gate === 'G6' ? store.blockingGate : null))
const otherGate = computed(() => (store.blockingGate && store.blockingGate.gate !== 'G6' ? store.blockingGate : null))
const awaiting = computed(() => s.value?.requestStage === 'awaiting_type')
const stopped = computed(() => s.value?.requestStage === 'stopped' || store.cancelled)

const railSteps = computed<RailStep[]>(() => [
  { label: '계약서 넣기', state: 'done' },
  store.blockingGate ? { label: '개인정보 가리기·조항 나누기', state: 'block', gate: store.blockingGate.gate } : { label: '개인정보 가리기·조항 나누기', state: 'now' },
  { label: '위험 조항 찾기', state: 'wait' },
  { label: '결과', state: 'wait' },
])

// 한눈에 보는 진행(2026-10-01) — 스크롤 없이 한 카드에: 진행 퍼센트 + 다섯 단계(상태 글자 · 굵기 · 색). 예전 '처리한 일 · 계약 요약 · 계약 유형' 세 칸을 합쳤다
type StepState = 'done' | 'now' | 'wait' | 'fail'
const railState = (step: string): StepState => {
  const st = s.value?.rail?.find((r) => r.step === step)?.state
  return st === 'done' || st === 'reused' ? 'done' : st === 'running' ? 'now' : st === 'blocked' ? 'fail' : 'wait'
}
const docs = computed(() => s.value?.documents ?? [])
const s2Steps = computed(() => {
  const read: StepState = docs.value.length ? 'done' : railState('received') === 'done' ? 'now' : railState('received')
  const deid = railState('deidentify')
  const split = railState('structure')
  const sumAll = docs.value.length > 0 && docs.value.every((d) => d.summaryStatus === 'ok' || d.summaryStatus === 'unavailable')
  const summary: StepState = sumAll ? 'done' : split === 'done' || docs.value.length ? 'now' : 'wait'
  const typeAll = docs.value.length > 0 && docs.value.every((d) => !!choice.value[d.documentId ?? -1])
  const type: StepState = typeAll ? 'done' : summary === 'done' || summary === 'now' ? 'now' : 'wait'
  const d0 = docs.value[0]
  // 지금 단계는 하나만 — 끝나지 않은 첫 단계만 '하는 중', 그 뒤는 '기다리는 중'(세 단계가 동시에 '하는 중'으로 보여 무엇을 하는지 흐렸다)
  const seq: StepState[] = [read, deid, split, summary, type]
  const firstOpen = seq.findIndex((x) => x !== 'done')
  const st = seq.map((x, k): StepState => (x === 'done' || x === 'fail' ? x : k === firstOpen ? 'now' : 'wait'))
  return [
    { key: 'read', label: '글자 읽기', state: st[0], note: d0 ? (d0.ocrApplied ? '이미지 속 글자도 읽었어요' : '다 읽었어요') : '계약서인지 확인하고 있어요' },
    { key: 'deid', label: '개인정보 가리기', state: st[1], note: deid === 'done' ? '이름 · 연락처 등을 가렸어요' : '주민번호 · 계좌 · 연락처 등' },
    { key: 'split', label: '조항 나누기', state: st[2], note: d0?.splitMethod === 'article' ? '제○조 · 항 · 호 번호대로' : d0?.splitMethod === 'semantic' ? '번호가 없어 내용 단위로' : '조 · 항 · 호로 나눠요' },
    { key: 'sum', label: '계약 요약', state: st[3], note: docs.value.some((d) => d.summaryStatus === 'unavailable') ? '요약은 못 만들었어요(분석은 계속)' : summary === 'done' ? '결과 화면에서 볼 수 있어요' : '핵심을 짧게 정리해요' },
    { key: 'type', label: '계약 유형', state: st[4], note: typeAll ? docs.value.map((d) => CONTRACT_TYPE[choice.value[d.documentId!] as ContractType]).join(' · ') : '어떤 계약인지 알아봐요' },
  ]
})
const STEP_WORD: Record<StepState, string> = { done: '끝', now: '하는 중', wait: '기다리는 중', fail: '멈춤' }
const s2Done = computed(() => s2Steps.value.filter((x) => x.state === 'done').length)
const s2Pct = computed(() => (s2Steps.value.reduce((n, x) => n + (x.state === 'done' ? 1 : x.state === 'now' ? 0.5 : 0), 0) / s2Steps.value.length) * 100)
const s2Now = computed(() => s2Steps.value.find((x) => x.state === 'now')?.label ?? null)

const confirmReason = computed<DisabledReason | null>(() => {
  if (store.blockingGate) return { gate: store.blockingGate.gate, text: store.blockingGate.title }
  if (store.cancelled) return { text: '취소한 분석이에요' }
  if (!awaiting.value) return { text: '조항 나누기가 끝나면 시작할 수 있어요' }
  const docs = s.value?.documents ?? []
  if (!docs.length || docs.some((d) => !choice.value[d.documentId ?? -1])) return { text: '계약 유형을 알아보고 있어요' }
  return null
})

const autoFailed = ref(false)
async function confirm() {
  const docs = s.value?.documents ?? []
  const ok = await store.confirmTypes(
    docs.map((d) => ({ documentId: d.documentId!, contractType: choice.value[d.documentId!] as ContractType })),
  )
  if (ok) router.replace(`/analyses/${id.value}/detection`)
  else autoFailed.value = true
}
// 처리가 끝나 시작할 수 있게 되면 예측 결과를 상자에 잠시 보여 준 뒤(AUTO_NEXT_MS) 한 번 자동으로 확정한다
const AUTO_NEXT_MS = 1500
const autoPending = ref(false)
let autoTried = false
let autoTimer: ReturnType<typeof setTimeout> | null = null
watch(
  confirmReason,
  (reason) => {
    if (reason || autoTried || store.confirming) return
    autoTried = true
    autoPending.value = true
    autoTimer = setTimeout(() => {
      autoPending.value = false
      void confirm()
    }, AUTO_NEXT_MS)
  },
  { immediate: true },
)
onUnmounted(() => autoTimer && clearTimeout(autoTimer))

async function doCancel() {
  const ok = await store.cancel()
  if (ok) cancelOpen.value = false
}

function onGate() {
  router.push('/')
}
</script>

<template>
  <div class="page">
    <div v-if="store.accessGate" class="section tight">
      <C2GateBlock :gate="store.accessGate" full @action="onGate" />
    </div>
    <template v-else>
      <!-- 세부 줄(접수 · 개인정보 가리기 …)은 아래 단계 카드와 겹쳐 뺐다(2026-10-01) -->
      <C1Rail :steps="railSteps">
        <ProgressWaitLine
          :elapsed-sec="store.elapsedSec"
          :notice="s?.modelNotice ?? null"
          :expected="EXPECTED_TEXT"
          :stopped="stopped || awaiting || !!store.blockingGate"
        />
      </C1Rail>

      <div class="page-head">
        <h1 class="t-display-lg">개인정보 가리기 · 조항 나누기</h1>
        <p v-if="s" class="t-body-sm charcoal m-0 mt-xs">
          보는 입장 <b>{{ PERSPECTIVE[s.perspective] }}</b> · 근거 자료 기준일 <b>{{ ymd(s.knowledgeDate) }}</b> — 이 기준으로 판단해요.
        </p>
        <p v-if="store.error" class="t-body-sm" role="status">{{ store.error }}</p>
      </div>

      <section v-if="store.cancelled && store.cancelResult" class="section tight card" role="status" data-part="cancelled">
        <h2 class="t-heading-sm">분석을 취소했어요</h2>
        <p class="t-body-sm charcoal m-0 mt-xs mb-md">
          하던 처리를 멈췄어요. 올린 원본 파일은 곧 지워져요.
        </p>
        <p class="mt-md"><RouterLink to="/" class="btn btn-secondary">새 분석 시작</RouterLink></p>
      </section>

      <section v-if="g6" class="section tight">
        <C2GateBlock :gate="g6" @action="router.push('/')" />
      </section>
      <section v-if="otherGate" class="section tight">
        <C2GateBlock :gate="otherGate" @action="onGate" />
      </section>

      <section class="section tight card s2-card" aria-labelledby="proc-h" data-part="s2-progress">
        <h2 id="proc-h" class="visually-hidden">진행 상황</h2>
        <ProgressMeter :percent="docs.length || s?.rail?.length ? s2Pct : null" label="개인정보 가리기 · 조항 나누기 진행" :done="s2Done === s2Steps.length" :stopped="!!store.blockingGate || store.cancelled">
          <b>{{ s2Done }}/{{ s2Steps.length }}</b> 단계 끝났어요<template v-if="s2Now"> · 지금 <b>{{ s2Now }}</b></template><template v-if="docs.length > 1"> · 계약 <b>{{ docs.length }}건</b>을 하나씩 나눠 분석해요</template>
        </ProgressMeter>
        <ol class="s2-steps" data-part="s2-steps">
          <li v-for="(x, k) in s2Steps" :key="x.key" :class="['s2-step', x.state]" :aria-current="x.state === 'now' ? 'step' : undefined">
            <span class="s2-ico" aria-hidden="true">{{ x.state === 'done' ? '✓' : x.state === 'fail' ? '!' : k + 1 }}</span>
            <span class="s2-body">
              <span class="s2-label">{{ x.label }}</span>
              <span class="s2-word">{{ STEP_WORD[x.state] }}</span>
              <span class="s2-note">{{ x.note }}</span>
            </span>
          </li>
        </ol>
        <div class="s2-type stack sm" data-part="contract-type-list">
          <div v-for="d in docs" :key="d.documentId" class="type-box" data-part="contract-type" :data-type="choice[d.documentId!] || undefined">
            <p class="m-0"><span class="type-label">파일</span>{{ d.displayName ?? `문서 ${d.docSeq}` }}</p>
            <p class="m-0">
              <span class="type-label">계약 유형</span>
              <strong v-if="choice[d.documentId!]">{{ CONTRACT_TYPE[choice[d.documentId!] as ContractType] }}</strong>
              <span v-else class="muted">알아보고 있어요…</span>
              <span v-if="choice[d.documentId!] && !d.contractTypeCandidate && !d.contractType" class="t-caption-sm muted"> (알아내지 못해서 기본 유형으로 정했어요)</span>
            </p>
          </div>
        </div>
        <p v-if="autoPending || store.confirming" class="t-body-sm m-0" role="status" data-part="auto-next"><b>다 알아봤어요.</b> 곧 다음 화면(위험 조항 찾기)으로 넘어가요…</p>
      </section>

      <section class="section tight row between">
        <C3ReasonButton :label="autoFailed ? '다시 시도' : '바로 위험 조항 찾기'" primary :reason="confirmReason" :busy="store.confirming" @click="confirm" />
        <button v-if="store.cancellable" type="button" class="btn btn-secondary" data-action="cancel-analysis" @click="cancelOpen = true">분석 취소</button>
      </section>

      <CancelAnalysisDialog :open="cancelOpen" :busy="store.cancelling" :failed="store.cancelFailed" @confirm="doCancel" @cancel="cancelOpen = false" />
    </template>
  </div>
</template>

<style scoped>
/* 한눈에 보는 진행(2026-10-01) — 다섯 단계를 한 줄(넓은 화면) · 두 줄 격자(좁은 화면)로. 상태는 글자 + 굵기 + 색: 끝 = 초록 ✓, 하는 중 = 잉크 굵게 + 테두리, 기다리는 중 = 옅게 */
.s2-card { display: grid; gap: var(--spacing-lg); }
.s2-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--spacing-sm); }
.s2-step { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border: 1px solid var(--color-hairline); border-radius: var(--rounded-md); background: var(--color-canvas); min-width: 0; }
.s2-ico { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: var(--rounded-full); background: var(--color-surface-soft); color: var(--color-body); font: 700 12px/1 var(--font-sans); }
.s2-body { display: grid; gap: 2px; min-width: 0; }
.s2-label { font: 600 14px/1.35 var(--font-sans); color: var(--color-ink); }
.s2-word { font: 700 12px/1.3 var(--font-sans); color: var(--color-body); }
.s2-note { font: 400 12px/1.4 var(--font-sans); color: var(--color-body); }
.s2-step.done .s2-ico { background: var(--color-success); color: #fff; }
.s2-step.done .s2-word { color: var(--color-success); }
.s2-step.now { border-color: var(--color-ink); box-shadow: none; }
.s2-step.now .s2-ico { background: var(--color-ink); color: var(--color-on-primary); }
.s2-step.now .s2-word { color: var(--color-ink); }
.s2-step.wait .s2-label { color: var(--color-body); font-weight: 500; }
.s2-step.fail { border-color: var(--color-danger); }
.s2-step.fail .s2-ico { background: var(--color-danger); color: #fff; }
.s2-step.fail .s2-word { color: var(--color-danger); }
@media (max-width: 900px) { .s2-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); } .s2-step:last-child { grid-column: 1 / -1; } }
/* 휴대폰 — 한 화면에: 단계는 한 줄씩(이름 · 상태), 설명은 지금 단계만 */
@media (max-width: 560px) { .s2-steps { grid-template-columns: 1fr; gap: 4px; } .s2-step { padding: 8px 10px; align-items: center; } .s2-body { grid-template-columns: 1fr auto; column-gap: 8px; } .s2-word { text-align: right; } .s2-note { grid-column: 1 / -1; } .s2-step:not(.now) .s2-note { display: none; } .s2-card { gap: var(--spacing-md); } }
@media (prefers-reduced-motion: no-preference) { .s2-step.now .s2-ico { animation: s2-pulse 1.4s ease-in-out infinite; } }
@keyframes s2-pulse { 50% { transform: scale(.86); } }
.type-box { padding: var(--spacing-md) var(--spacing-lg); border-radius: var(--rounded-md); background: var(--color-surface-soft); display: grid; gap: var(--spacing-xs); font: 400 14px/1.5 var(--font-sans); }
.type-label { display: inline-block; min-width: 5.5em; margin-right: var(--spacing-sm); color: var(--color-body); } /* 이름표 · 값 두 칸(쌍점 대신 칸 맞춤, 2026-10-01) */
</style>
