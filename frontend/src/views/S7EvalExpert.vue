<script setup lang="ts">
// S7-E 탐지 품질 평가 — 법률 전문가 뷰 [추론] (SD_02 §11) — T137.
// 평가 데이터 채택/부적격(인위적 변형·학습 중복은 G10 — 채택 불가), 근거 적합성 판정 표본(C5·C6·D1).
// 고른 판단은 "회신 보내기"(채운 검정 버튼 1개)로 한꺼번에 보내며, 운영자 화면의 G10·G11 상태가 갱신된다.
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { toGateView, type GateView } from '@/lib/gates'
import { CATEGORY, CONTRACT_TYPE, ORIGIN } from '@/lib/labels'
import { ymd, ymdhm } from '@/lib/format'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import C5VerdictBadge from '@/components/common/C5VerdictBadge.vue'
import C6EvidenceChip from '@/components/common/C6EvidenceChip.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import D1SourceDrawer from '@/components/common/D1SourceDrawer.vue'
import type { EvalItem, EvalOverview, Evidence, EvidenceReviewSample } from '@/api/types'

type Decision = 'accepted' | 'rejected'
type Verdict = 'relevant' | 'irrelevant'
type Sample = EvidenceReviewSample & { contractType?: string; reused?: boolean; respondedAt?: string | null }
interface RunRow { evalRunId: number; stage: string; knowledgeDate?: string; m3?: string }

const route = useRoute()
const router = useRouter()
const tab = ref<'review' | 'fit'>(route.query.tab === 'fit' ? 'fit' : 'review')
const items = ref<EvalItem[]>([])
const pageGate = ref<GateView | null>(null)
const rowGate = ref<Record<number, GateView | null>>({})
const choice = ref<Record<number, Decision>>({})
const saved = ref<Record<number, Decision>>({})
const runs = ref<RunRow[]>([])
const runId = ref<number | null>(Number(route.query.run) || null)
const samples = ref<Sample[] | null>(null)
const verdicts = ref<Record<string, Verdict>>({})
const savedVerdicts = ref<Record<string, Verdict>>({})
const busy = ref(false)
const msg = ref<string | null>(null)
const drawerOpen = ref(false)
const drawerEv = ref<Evidence | null>(null)
const opener = ref<HTMLElement | null>(null)

const key = (s: Sample) => `${s.evalItemId}-${s.evidenceVersionId}`

async function loadItems() {
  try {
    items.value = await api.evalItems('pending')
  } catch (e) {
    if (e instanceof GateApiError) pageGate.value = toGateView(e.body)
  }
}
async function loadRuns() {
  const ov = (await api.evalOverview().catch(() => null)) as (EvalOverview & { runs?: RunRow[] }) | null
  runs.value = (ov?.runs ?? []).filter((r) => ['awaiting_expert', 'result', 'recorded'].includes(r.stage))
  if (!runId.value) runId.value = runs.value.find((r) => r.stage === 'awaiting_expert')?.evalRunId ?? null
}
async function loadSamples() {
  if (!runId.value) return
  samples.value = ((await api.evidenceReviews(runId.value).catch(() => [])) as Sample[])
  verdicts.value = {}
  savedVerdicts.value = {}
  for (const s of samples.value) if (s.verdict) savedVerdicts.value[key(s)] = s.verdict
  router.replace({ query: { ...route.query, run: String(runId.value) } })
}
onMounted(async () => {
  await loadItems()
  if (pageGate.value) return
  await loadRuns()
  if (runId.value) await loadSamples()
})

const blocked = (i: EvalItem) => i.origin === 'synthetic' || !!i.overlapsTraining
const pendingItems = computed(() => Object.keys(choice.value).length)
const pendingVerdicts = computed(() => Object.keys(verdicts.value).length)
const answered = computed(() => (samples.value ?? []).filter((s) => savedVerdicts.value[key(s)]).length)

/** 회신 보내기 — 검수 결과(7.2)와 근거 적합성 판정(7.7)을 보낸다. 실패한 행은 선택을 남겨 다시 보낼 수 있다 */
async function reply() {
  busy.value = true
  msg.value = null
  let ok = 0
  let fail = 0
  for (const [idStr, d] of Object.entries(choice.value)) {
    const id = Number(idStr)
    try {
      await api.reviewEvalItem(id, d)
      saved.value[id] = d
      delete choice.value[id]
      rowGate.value[id] = null
      ok++
    } catch (e) {
      fail++
      if (e instanceof GateApiError) rowGate.value[id] = toGateView(e.body)
    }
  }
  if (runId.value) {
    for (const s of samples.value ?? []) {
      const v = verdicts.value[key(s)]
      if (!v) continue
      try {
        await api.putEvidenceReview(runId.value, s.evalItemId, s.evidenceVersionId, v)
        savedVerdicts.value[key(s)] = v
        delete verdicts.value[key(s)]
        ok++
      } catch {
        fail++
      }
    }
  }
  busy.value = false
  msg.value = fail ? `${ok}건 보냄, ${fail}건 실패 - 실패한 항목은 고른 값이 그대로 남아 있습니다. 다시 보내세요` : `${ok}건의 검토 결과를 보냈습니다`
}

const replyReason = computed<DisabledReason | null>(() => (pendingItems.value + pendingVerdicts.value === 0 ? { text: '보낼 검토 결과가 없습니다' } : null))
const railSteps = computed<RailStep[]>(() => {
  const itemsDone = items.value.length > 0 && items.value.every((i) => saved.value[i.evalItemId!])
  const fitDone = !!samples.value?.length && answered.value === samples.value.length
  return [
    { label: '평가 데이터 검토', state: tab.value === 'review' ? 'now' : itemsDone ? 'done' : 'wait' },
    { label: '근거가 맞는지 판단', state: tab.value === 'fit' ? (fitDone ? 'done' : 'now') : fitDone ? 'done' : 'wait' },
    { label: '검토 결과 보내기', state: pendingItems.value + pendingVerdicts.value === 0 && (itemsDone || fitDone) ? 'done' : 'wait' },
  ]
})
/** 화면에 보이는 판정 = 아직 보내지 않은 선택, 없으면 회신된 판정 */
const shown = (s: Sample): Verdict | undefined => verdicts.value[key(s)] ?? savedVerdicts.value[key(s)]
function pick(s: Sample, v: Verdict) {
  if (savedVerdicts.value[key(s)] === v) delete verdicts.value[key(s)]
  else verdicts.value[key(s)] = v
}
function openEv(ev: Evidence, el: HTMLElement) {
  drawerEv.value = ev
  opener.value = el
  drawerOpen.value = true
}
function setTab(t: 'review' | 'fit') {
  tab.value = t
  router.replace({ query: { ...route.query, tab: t } })
}
</script>

<template>
  <div class="page">
    <div v-if="pageGate" class="section tight"><C2GateBlock :gate="pageGate" full @action="router.push('/')" /></div>
    <template v-else>
      <C1Rail :label="`전문가 검토${runId ? ` · EV-${runId}` : ''}`" :steps="railSteps" />
      <div class="page-head">
        <h1 class="t-display-lg">전문가 검토</h1>
        <p class="lede">평가에 쓸 조항을 받아들일지, 모델이 붙인 근거가 조항과 맞는지 판단해 검토 결과를 보내는 화면입니다. 운영자는 두 탭에서 항목마다 고른 뒤 아래 '검토 결과 보내기'를 누릅니다. 보이는 조항은 모두 개인정보를 가린 글입니다(〔이름〕처럼 종류만 남김). 검토한 사람과 날짜는 보낼 때 로그인한 계정으로 기록됩니다.</p>
        <p v-if="msg" role="status" class="t-body-sm">{{ msg }}</p>
      </div>
      <div class="tabs section tight" role="tablist">
        <button type="button" role="tab" class="tab" :aria-selected="tab === 'review' ? 'true' : 'false'" @click="setTab('review')">평가 데이터 검토 {{ items.length }}</button>
        <button type="button" role="tab" class="tab" :aria-selected="tab === 'fit' ? 'true' : 'false'" @click="setTab('fit')">근거가 맞는지 판단 {{ samples?.length ?? '' }}</button>
      </div>

      <section v-if="tab === 'review'" role="tabpanel" aria-label="평가 데이터 검토">
        <C7AreaPlaceholder v-if="!items.length" kind="na" text="검토할 평가 데이터가 없습니다" />
        <div v-else class="tablewrap">
          <table class="spec" data-part="eval-items">
            <thead><tr><th>조항</th><th>계약 유형</th><th>붙인 정답</th><th>어디서 왔나</th><th>검토</th></tr></thead>
            <tbody>
              <tr v-for="i in items" :key="i.evalItemId">
                <td class="cell-wide"><C8Masked :text="i.clauseTextDeid ?? ''" /></td>
                <td>{{ CONTRACT_TYPE[i.contractType!] ?? i.contractType }}</td>
                <td>{{ CATEGORY[i.goldCategory!] ?? i.goldCategory }}</td>
                <td>{{ ORIGIN[i.origin ?? ''] ?? i.origin }}<template v-if="i.overlapsTraining"> · 모델 학습에 이미 쓴 문장</template></td>
                <td>
                  <span v-if="saved[i.evalItemId!]" class="t-body-sm-strong">{{ saved[i.evalItemId!] === 'accepted' ? '✓ 받아들임으로 보냄' : '쓰지 않음으로 보냄' }}</span>
                  <div v-else class="stack sm" role="radiogroup" :aria-label="`평가 데이터 ${i.evalItemId} 검토`">
                    <span v-if="blocked(i)" class="reason t-body-sm"><b>G10</b> 받아들일 수 없음 - 평가 데이터에 넣을 수 없는 항목입니다(바꿀 수 없음)</span>
                    <label v-else class="choice"><input v-model="choice[i.evalItemId!]" type="radio" :name="`d-${i.evalItemId}`" value="accepted" /> 받아들임(평가에 사용)</label>
                    <label class="choice"><input v-model="choice[i.evalItemId!]" type="radio" :name="`d-${i.evalItemId}`" value="rejected" /> 쓰지 않음</label>
                  </div>
                  <C2GateBlock v-if="rowGate[i.evalItemId!]" :gate="rowGate[i.evalItemId!]!" :autofocus="false" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-else role="tabpanel" aria-label="근거가 맞는지 판단" class="stack">
        <form class="row" @submit.prevent="loadSamples">
          <label class="t-body-sm">어느 평가의 표본인지
            <select v-if="runs.length" v-model.number="runId" class="text-input w-auto">
              <option v-for="r in runs" :key="r.evalRunId" :value="r.evalRunId">EV-{{ r.evalRunId }} · {{ ymd(r.knowledgeDate) }} · {{ r.stage === 'awaiting_expert' ? '판단 기다리는 중' : '보내기 완료' }}</option>
            </select>
            <input v-else v-model.number="runId" type="number" class="text-input w-sm" />
          </label>
          <button type="submit" class="btn btn-secondary">검토할 표본 불러오기</button>
        </form>
        <C7AreaPlaceholder v-if="!runId" kind="na" text="근거 판단을 요청한 평가가 없습니다" />
        <C7AreaPlaceholder v-else-if="samples && !samples.length" kind="na" text="판단할 표본이 없습니다" />
        <p v-if="samples?.length" class="t-body-sm charcoal">표본 {{ samples.length }}건 중 {{ answered }}건 보냄 · 골랐지만 아직 안 보낸 것 {{ pendingVerdicts }}건</p>
        <article v-for="s in samples ?? []" :key="key(s)" class="card stack sm" :data-answered="savedVerdicts[key(s)] ? 'yes' : 'no'">
          <p class="t-body-md m-0"><C8Masked :text="s.clauseTextDeid ?? ''" /></p>
          <C5VerdictBadge v-if="s.displayCategory" :category="s.displayCategory" :risk-type="s.riskType" :risk-level="s.riskLevel" :confidence="s.confidence" />
          <div class="chips">
            <span class="t-body-sm muted">근거:</span>
            <C6EvidenceChip v-if="s.evidence" :evidence="s.evidence" @open="openEv" />
            <span v-else class="t-body-sm">근거 원문이 없습니다</span>
          </div>
          <div class="row" role="radiogroup" :aria-label="`표본 ${s.evalItemId} 근거가 맞는지`">
            <label class="choice"><input type="radio" :name="`v-${key(s)}`" value="relevant" :checked="shown(s) === 'relevant'" @change="pick(s, 'relevant')" /> 조항과 맞는 근거</label>
            <label class="choice"><input type="radio" :name="`v-${key(s)}`" value="irrelevant" :checked="shown(s) === 'irrelevant'" @change="pick(s, 'irrelevant')" /> 맞지 않는 근거</label>
          </div>
          <p v-if="savedVerdicts[key(s)]" class="t-body-sm charcoal">
            ✓ 보냄 - {{ savedVerdicts[key(s)] === 'relevant' ? '맞는 근거' : '맞지 않는 근거' }}<template v-if="s.reused"> · 근거가 그대로여서 이전 평가의 판단을 다시 씀</template><template v-if="s.respondedAt"> · {{ ymdhm(s.respondedAt) }}</template>
          </p>
        </article>
      </section>

      <section class="section tight row">
        <C3ReasonButton :label="`검토 결과 보내기 - 근거 판단 ${pendingVerdicts}건 · 평가 데이터 ${pendingItems}건`" primary :reason="replyReason" :busy="busy" @click="reply" />
      </section>
      <D1SourceDrawer :open="drawerOpen" :evidence="drawerEv" :opener="opener" @close="drawerOpen = false" />
    </template>
  </div>
</template>
