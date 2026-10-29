<script setup lang="ts">
// S3 위험 탐지 진행·완료 (SD_02 §7) — T085. 재분석 모드(S6 에서 진입)도 같은 화면.
// 분석이 끝나면 결과를 저장하고 결과 화면으로 자동 이동한다(2026-09-30 — "결과 보기" 버튼 없음). 저장에 실패하면 다시 시도 버튼을 보인다.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAnalysisStore } from '@/stores/analysis'
import { CONTRACT_TYPE, PERSPECTIVE } from '@/lib/labels'
import { ymd } from '@/lib/format'
import { railDetail, EXPECTED_TEXT } from '@/composables/progress'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C5VerdictBadge from '@/components/common/C5VerdictBadge.vue'
import CancelAnalysisDialog from '@/components/common/CancelAnalysisDialog.vue'
import ProgressMeter from '@/components/common/ProgressMeter.vue'
import ProgressWaitLine from '@/components/common/ProgressWaitLine.vue'
import type { GateView } from '@/lib/gates'

const props = defineProps<{ requestId: string }>()
const store = useAnalysisStore()
const router = useRouter()
const route = useRoute()
const id = computed(() => Number(props.requestId))
const expectRun = computed(() => Number(route.query.run) || null)
const cancelOpen = ref(false)

onMounted(() => store.start(id.value, { expectRunId: expectRun.value }))
onUnmounted(() => store.stop())
watch(id, (v) => store.start(v, { expectRunId: expectRun.value }))

const s = computed(() => store.status)
const run = computed(() => s.value?.run ?? null)
const re = computed(() => store.isReanalysis)

// 아직 유형 확정 전이면 S2 로 돌려보낸다
watch(
  () => [s.value?.requestStage, run.value] as const,
  ([stage, r]) => {
    if (stage && !r && stage !== 'type_confirmed' && stage !== 'stopped') router.replace(`/analyses/${id.value}/structuring`)
  },
)

const gate = computed<GateView | null>(() => {
  const g = store.blockingGate
  if (!g) return null
  if (g.gate === 'G5') {
    return { ...g, nextActions: [{ id: 'restart', label: '처음부터 다시 시도' }] }
  }
  if (g.gate === 'G7') return { ...g, nextActions: [] }
  return g
})

const railSteps = computed<RailStep[]>(() => {
  const labels = re.value ? ['기록 보기', '바뀐 근거 확인', '다시 분석', '새 결과'] : ['계약서 넣기', '개인정보 가리기·조항 나누기', '위험 조항 찾기', '결과']
  const third: RailStep = gate.value
    ? { label: labels[2], state: 'block', gate: gate.value.gate }
    : store.completed ? { label: labels[2], state: 'done' } : { label: labels[2], state: 'now' }
  return [
    { label: labels[0], state: 'done' },
    { label: labels[1], state: 'done' },
    third,
    { label: labels[3], state: 'wait' },
  ]
})

// 진행 퍼센트(2026-10-01) — 조항 살펴보기 60% + 위험 조항 판단 40%. 끝나면 100
const progressPct = computed<number | null>(() => {
  const r = run.value
  if (store.completed) return 100
  if (!r?.clauseTotal) return null
  const scan = Math.min(1, (r.scoredCount ?? 0) / r.clauseTotal) * 60
  if (r.riskTotal == null) return scan
  return 60 + (r.riskTotal === 0 ? 40 : Math.min(1, (r.judgedCount ?? 0) / r.riskTotal) * 40)
})

// ---- 판정된 위험 조항을 진행 중에 먼저 보여 준다(2026-09-30). 판정 순서 = 위험 점수 높은 순, 설명·근거는 결과 화면에서
const judged = computed(() => run.value?.judged ?? [])
const showLive = computed(() => (run.value?.riskTotal ?? 0) > 0 && !gate.value && !store.cancelled)
const remaining = computed(() => Math.max(0, (run.value?.riskTotal ?? 0) - (run.value?.judgedCount ?? 0)))
function liveLabel(c: { articleNo?: string; paragraphNo?: string; itemNo?: string; title?: string; seq: number }) {
  return [c.articleNo, c.paragraphNo, c.itemNo, c.title].filter(Boolean).join(' ') || `조항 ${c.seq}`
}
// 남은 시간: 이 화면에서 본 판정 속도(첫 관측 이후 판정 수 / 경과)로 어림한다. 2개 이상 늘어난 뒤에만 보인다
const firstSeen = ref<{ at: number; count: number } | null>(null)
const etaSec = ref<number | null>(null)
watch(
  () => run.value?.judgedCount,
  (n) => {
    if (n == null) return
    const now = Date.now()
    if (!firstSeen.value) firstSeen.value = { at: now, count: n }
    const done = n - firstSeen.value.count
    const sec = (now - firstSeen.value.at) / 1000
    etaSec.value = done >= 2 && sec > 0 && remaining.value > 0 ? Math.max(1, Math.round((remaining.value * sec) / done)) : null
  },
  { immediate: true },
)

const contractTypes = computed(() =>
  (s.value?.documents ?? []).map((d) => (d.contractType ? CONTRACT_TYPE[d.contractType] : '')).filter(Boolean).join(' · '),
)
const outOfScope = computed(() => (s.value?.documents ?? []).some((d) => d.contractType === 'out_of_scope'))

// 끝나면 곧바로 저장 → 결과 화면. 한 번만 시도하고, 실패하면 "다시 시도"로 사용자가 부른다
const autoTried = ref(false)
const saveFailed = ref(false)
async function openResult() {
  saveFailed.value = false
  const url = await store.save()
  if (url) await router.replace(url)
  else saveFailed.value = true
}
watch(
  () => store.completed && !gate.value && !store.cancelled,
  (ready) => {
    if (ready && !autoTried.value) {
      autoTried.value = true
      void openResult()
    }
  },
  { immediate: true },
)

async function doCancel() {
  const ok = await store.cancel()
  if (ok) cancelOpen.value = false
}

function onGate(action: string) {
  if (action === 'recheck_status') void store.fetchOnce()
  else router.push('/')
}
</script>

<template>
  <div class="page">
    <div v-if="store.accessGate" class="section tight">
      <C2GateBlock :gate="store.accessGate" full @action="onGate" />
    </div>
    <template v-else>
      <C1Rail :steps="railSteps" :detail="s ? railDetail(s) : null">
        <ProgressWaitLine
          :elapsed-sec="store.elapsedSec"
          :notice="s?.modelNotice ?? null"
          :expected="EXPECTED_TEXT"
          :stopped="store.completed || store.cancelled || !!gate"
        />
      </C1Rail>

      <div class="page-head">
        <h1 class="t-display-lg">{{ re ? '다시 분석' : '위험 조항 찾기' }}</h1>
        <p v-if="store.error" class="t-body-sm" role="status">{{ store.error }}</p>
      </div>

      <section class="section tight card" aria-labelledby="prog-h">
        <h2 id="prog-h" class="t-heading-sm mb-md">진행 상황</h2>
        <!-- 진행 문장 — 숫자는 굵게(2026-10-01) -->
        <ProgressMeter :percent="progressPct" label="위험 조항 찾기 진행" :done="store.completed && !gate" :stopped="!!gate || store.cancelled">
          <span data-part="progress">
            <template v-if="!run?.clauseTotal">조항을 모으고 있어요</template>
            <template v-else-if="gate?.gate === 'G5'">조항 <b>{{ run.clauseTotal }}개</b> 중 <b>{{ run.scoredCount ?? 0 }}개</b>를 살펴본 뒤 멈췄어요</template>
            <template v-else-if="run.riskTotal === 0">조항 <b>{{ run.clauseTotal }}개</b>를 살펴봤어요 · 위험해 보이는 조항이 없어요</template>
            <template v-else-if="run.riskTotal != null">조항 <b>{{ run.clauseTotal }}개</b>를 살펴봤어요 · 위험해 보이는 조항 <b>{{ run.riskTotal }}개</b> 중 <b>{{ run.judgedCount ?? 0 }}개</b>를 판단했어요</template>
            <template v-else>조항 <b>{{ run.clauseTotal }}개</b> 중 <b>{{ run.scoredCount ?? 0 }}개</b>를 살펴봤어요</template>
          </span>
        </ProgressMeter>
        <p v-if="s" class="t-body-sm charcoal m-0 mt-md" data-part="conditions">
          <template v-if="contractTypes">계약 유형 {{ contractTypes }} · </template>보는 입장 {{ PERSPECTIVE[s.perspective] }} · 근거 자료 기준일 {{ ymd(s.knowledgeDate) }}
        </p>
        <p v-if="re" class="t-body-sm charcoal m-0 mt-sm">개인정보 가리기와 조항 나누기는 지난번 결과를 그대로 써요.</p>
      </section>

      <section v-if="showLive" class="section tight card" aria-labelledby="live-h" aria-live="polite" data-part="live">
        <h2 id="live-h" class="t-heading-sm">지금까지 찾은 위험 조항</h2>
        <p class="t-body-sm charcoal m-0 mt-xs">위험해 보이는 조항부터 먼저 판단해요. 설명과 근거는 결과 화면에서 볼 수 있어요.</p>
        <ul class="live-list mt-sm">
          <li v-for="c in judged" :key="c.clauseId" class="live-item" data-part="live-item">
            <C5VerdictBadge :category="c.category" />
            <span class="t-body-sm live-text"><strong>{{ liveLabel(c) }}</strong> {{ c.preview }}…</span>
          </li>
          <li v-if="remaining > 0 && !store.completed" class="live-item charcoal t-body-sm" data-part="live-pending">
            <span>판단하는 중… (남은 <b>{{ remaining }}개</b><template v-if="etaSec"> · 약 <b>{{ etaSec }}초</b></template>)</span>
          </li>
        </ul>
        <p v-if="run?.judgedNormalCount" class="t-body-sm charcoal m-0 mt-xs">살펴보니 문제없는 조항 {{ run.judgedNormalCount }}개는 목록에서 뺐어요.</p>
      </section>

      <section v-if="gate" class="section tight">
        <C2GateBlock :gate="gate" @action="onGate" />
      </section>

      <section v-if="store.cancelled && store.cancelResult" class="section tight card" role="status" data-part="cancelled">
        <h2 class="t-heading-sm">분석을 취소했어요</h2>
        <p class="t-body-sm charcoal m-0 mt-xs mb-md">
          하던 처리를 멈췄어요. 올린 원본 파일은 곧 지워져요.
        </p>
        <p class="mt-md"><RouterLink to="/" class="btn btn-secondary">새 분석 시작</RouterLink></p>
      </section>

      <section v-if="store.completed && !gate" class="section tight card strong" role="status" data-part="done">
        <h2 class="t-heading-sm">분석이 끝났어요</h2>
        <p v-if="!saveFailed" class="t-body-sm charcoal m-0 mt-xs" data-part="auto-open">결과를 분석 기록에 저장하고, 결과 화면으로 넘어가요…</p>
        <template v-else>
          <p role="alert" class="t-body-sm m-0 mt-xs">결과를 저장하지 못했어요. 다시 시도해 주세요.</p>
          <button type="button" class="btn btn-primary mt-md" :aria-busy="store.saving ? 'true' : undefined" data-action="retry-save" @click="openResult">다시 시도</button>
        </template>
        <p v-if="outOfScope" class="t-body-sm m-0 mt-sm">
          이 계약 유형은 근거 자료가 아직 넉넉하지 않아요. 결과는 참고로만 보시고, 전문가에게도 한번 확인받아 보세요.
        </p>
      </section>

      <section v-if="store.cancellable" class="section tight row justify-end">
        <button type="button" class="btn btn-secondary" data-action="cancel-analysis" @click="cancelOpen = true">분석 취소</button>
      </section>

      <CancelAnalysisDialog :open="cancelOpen" :busy="store.cancelling" :failed="store.cancelFailed" @confirm="doCancel" @cancel="cancelOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.live-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs, 8px); }
.live-item { display: flex; align-items: baseline; gap: var(--space-sm, 12px); min-width: 0; }
.live-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
