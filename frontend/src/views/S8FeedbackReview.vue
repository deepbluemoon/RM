<script setup lang="ts">
// S8 사용자 피드백 검토 (SD_02 §12) — T139. 판정 수정 조작 없음(U6). 운영자의 최대 조작 = 평가 데이터 후보 지정.
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { toGateView, type GateView } from '@/lib/gates'
import { CATEGORY, FEEDBACK_TYPE, REVIEW_DECISION } from '@/lib/labels'
import { ymd, ymdhm } from '@/lib/format'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import C4BasisBand from '@/components/common/C4BasisBand.vue'
import C5VerdictBadge from '@/components/common/C5VerdictBadge.vue'
import C6EvidenceChip from '@/components/common/C6EvidenceChip.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import D1SourceDrawer from '@/components/common/D1SourceDrawer.vue'
import { vSmoothDetails } from '@/lib/smoothDetails' // 펼치기 부드럽게(2026-10-01)
import type { Evidence, FeedbackDetail, FeedbackRow } from '@/api/types'

type Decision = 'valid' | 'invalid' | 'needs_expert'
const router = useRouter()
const filter = ref<{ type: string; reviewStatus: string; kvId: string }>({ type: '', reviewStatus: 'unreviewed', kvId: '' })
const rows = ref<FeedbackRow[]>([])
const summary = ref<Record<string, unknown>[]>([])
const pageGate = ref<GateView | null>(null)
const selected = ref<number | null>(null)
const detail = ref<FeedbackDetail | null>(null)
const decision = ref<Decision | null>(null)
const savedDecision = ref<Decision | null>(null)
const busy = ref<string | null>(null)
const msg = ref<string | null>(null)
const candidateDone = ref(false)
const drawerOpen = ref(false)
const drawerEv = ref<Evidence | null>(null)
const opener = ref<HTMLElement | null>(null)

async function loadList() {
  try {
    rows.value = await api.adminFeedback({
      type: filter.value.type || undefined,
      reviewStatus: filter.value.reviewStatus || undefined,
      kvId: filter.value.kvId ? Number(filter.value.kvId) : undefined,
    })
  } catch (e) {
    if (e instanceof GateApiError) pageGate.value = toGateView(e.body)
  }
}
onMounted(async () => {
  await loadList()
  summary.value = await api.adminFeedbackSummary().catch(() => [])
})

async function open(id: number) {
  selected.value = id
  detail.value = null
  msg.value = null
  candidateDone.value = false
  try {
    detail.value = await api.adminFeedbackDetail(id)
    savedDecision.value = (detail.value.reviewDecision as Decision | null) ?? null
    decision.value = savedDecision.value
  } catch (e) {
    if (e instanceof GateApiError) pageGate.value = toGateView(e.body)
  }
}

const g13 = computed<GateView | null>(() => {
  const g = detail.value?.gates?.find((x) => x.gate === 'G13')
  return g ? toGateView(g) : null
})
const counts = computed(() => ({
  unreviewed: rows.value.filter((r) => r.reviewStatus === 'unreviewed').length,
  fp: rows.value.filter((r) => r.feedbackType === 'false_positive').length,
  fn: rows.value.filter((r) => r.feedbackType === 'false_negative').length,
}))

const railSteps = computed<RailStep[]>(() => [
  { label: '의견 목록', state: selected.value ? 'done' : 'now' },
  g13.value ? { label: '의견 자세히 보기', state: 'block', gate: 'G13' } : { label: '의견 자세히 보기', state: selected.value ? (savedDecision.value ? 'done' : 'now') : 'wait' },
  { label: '검토 결과 저장', state: savedDecision.value ? 'done' : 'wait' },
  { label: '평가 데이터 후보로 넘기기', state: candidateDone.value ? 'done' : savedDecision.value === 'valid' ? 'now' : 'wait' },
])

const saveReason = computed<DisabledReason | null>(() => {
  if (g13.value) return { gate: 'G13', text: '개인정보를 가리는 중' }
  if (!decision.value) return { text: '검토 결과를 고르세요' }
  return null
})
const candReason = computed<DisabledReason | null>(() => {
  if (g13.value) return { gate: 'G13', text: '개인정보를 가리는 중' }
  if (candidateDone.value) return { text: '이미 평가 데이터 후보로 넘겼습니다' }
  if (savedDecision.value !== 'valid') return { text: "'의견이 맞음'으로 저장한 의견만 넘길 수 있습니다" }
  return null
})

async function save() {
  if (!selected.value || !decision.value) return
  busy.value = 'save'
  try {
    await api.reviewFeedback(selected.value, decision.value)
    savedDecision.value = decision.value
    msg.value = '검토 결과를 저장했습니다'
    await loadList()
  } catch {
    msg.value = '저장하지 못했습니다 - 다시 시도하세요'
  } finally {
    busy.value = null
  }
}
async function candidate() {
  if (!selected.value) return
  busy.value = 'cand'
  try {
    await api.makeEvalCandidate(selected.value)
    candidateDone.value = true
    msg.value = '평가 데이터 후보로 넘겼습니다. 법률 전문가 검토를 거쳐야 실제 평가 데이터가 됩니다'
  } catch {
    msg.value = '후보로 넘기지 못했습니다 - 다시 시도하세요'
  } finally {
    busy.value = null
  }
}
function openEv(ev: Evidence, el: HTMLElement) {
  drawerEv.value = ev
  opener.value = el
  drawerOpen.value = true
}
</script>

<template>
  <div class="page">
    <div v-if="pageGate" class="section tight"><C2GateBlock :gate="pageGate" full @action="router.push('/')" /></div>
    <template v-else>
      <C1Rail :label="`이용자 의견 검토${selected ? ` · FB-${selected}` : ''}`" :steps="railSteps" />
      <div class="page-head">
        <h1 class="t-display-lg">이용자 의견 검토</h1>
        <p class="lede">이용자가 판단 결과에 남긴 의견(위험하지 않은데 위험으로 표시됨 · 놓친 위험 조항)을 운영자가 하나씩 읽고 맞는지 판단하는 화면입니다. 여기서 판단 결과 자체는 바뀌지 않습니다. 맞는 의견은 '평가 데이터 후보로 넘기기'를 눌러 품질 점검에 쓰도록 넘기세요.</p>
      </div>

      <section class="section tight">
        <form class="row" @submit.prevent="loadList">
          <span class="t-body-sm charcoal">아직 검토 안 함 {{ counts.unreviewed }} · 위험하지 않은데 위험으로 표시됨 {{ counts.fp }} · 놓친 위험 조항 {{ counts.fn }}</span>
          <label class="visually-hidden" for="f-type">의견 종류</label>
          <select id="f-type" v-model="filter.type" class="text-input w-auto">
            <option value="">의견 종류 전체</option>
            <option value="false_positive">위험하지 않은데 위험으로 표시됨</option>
            <option value="false_negative">놓친 위험 조항</option>
          </select>
          <label class="visually-hidden" for="f-status">검토 상태</label>
          <select id="f-status" v-model="filter.reviewStatus" class="text-input w-auto">
            <option value="">검토 상태 전체</option>
            <option value="unreviewed">아직 검토 안 함</option>
            <option value="reviewed">검토됨</option>
          </select>
          <label class="visually-hidden" for="f-kv">근거 자료 기준일 번호</label>
          <input id="f-kv" v-model="filter.kvId" class="text-input w-sm" placeholder="근거 자료 기준일 번호" inputmode="numeric" />
          <button type="submit" class="btn btn-secondary">찾기</button>
        </form>
        <details v-if="summary.length" v-smooth-details class="code">
          <summary>근거 자료 기준일별 검토 현황</summary>
          <div class="tablewrap">
            <table class="spec">
              <thead><tr><th v-for="k in Object.keys(summary[0])" :key="k">{{ k }}</th></tr></thead>
              <tbody><tr v-for="(s, i) in summary" :key="i"><td v-for="k in Object.keys(summary[0])" :key="k">{{ s[k] }}</td></tr></tbody>
            </table>
          </div>
        </details>
      </section>

      <section class="section tight">
        <C7AreaPlaceholder v-if="!rows.length" kind="na" text="조건에 맞는 의견이 없습니다" />
        <div v-else class="tablewrap">
          <table class="spec" data-part="feedback-rows">
            <thead><tr><th>번호</th><th>의견 종류</th><th>당시 판단</th><th>근거 자료 기준일</th><th>보낸 시각</th><th>검토 결과</th><th /></tr></thead>
            <tbody>
              <tr v-for="r in rows" :key="r.feedbackId">
                <td class="mono">FB-{{ r.feedbackId }}</td>
                <td>{{ FEEDBACK_TYPE[r.feedbackType ?? ''] }}</td>
                <td>{{ r.categoryAtSubmit ? CATEGORY[r.categoryAtSubmit] : '' }}</td>
                <td>{{ ymd(r.knowledgeDate) }}</td>
                <td>{{ ymdhm(r.submittedAt) }}</td>
                <td>{{ r.reviewDecision ? REVIEW_DECISION[r.reviewDecision] : r.reviewStatus === 'reviewed' ? '검토됨' : '아직 검토 안 함' }}</td>
                <td><button type="button" class="btn btn-secondary" @click="open(r.feedbackId!)">자세히 보기</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="selected && detail" class="section tight stack" aria-label="의견 자세히 보기" data-part="detail">
        <C4BasisBand disclaimer="의견을 보낼 당시의 판단 기준" :knowledge-date="detail.knowledgeDate" variant="review">
          <span v-if="detail.evidenceChangedSince"><strong>그 뒤 근거 자료가 바뀜</strong></span>
        </C4BasisBand>
        <div class="card stack sm">
          <h3>의견이 달린 조항</h3>
          <C7AreaPlaceholder v-if="detail.targetAvailable === false" kind="unavailable" text="조항을 보여 줄 수 없음 - 이용자가 결과를 삭제했습니다. 검토는 계속할 수 있습니다" />
          <template v-else>
            <p v-if="detail.clause" class="t-body-md m-0"><C8Masked :text="detail.clause.text" /></p>
            <C5VerdictBadge
              v-if="detail.judgment"
              :category="detail.judgment.displayCategory"
              :risk-type="detail.judgment.riskType"
              :risk-level="detail.judgment.riskLevel"
              :confidence="detail.judgment.confidence"
              :evidence-unconfirmed="detail.judgment.evidenceUnconfirmed"
            />
            <div v-if="detail.judgment" class="chips"><span class="t-body-sm muted">근거:</span><C6EvidenceChip v-for="e in detail.judgment.evidence" :key="e.evidenceVersionId" :evidence="e" @open="openEv" /></div>
          </template>
        </div>
        <div class="card">
          <h3>이용자 의견</h3>
          <dl class="kv">
            <dt>의견 종류</dt><dd>{{ FEEDBACK_TYPE[detail.feedbackType ?? ''] }}</dd>
            <dt>보낸 사람</dt><dd>알 수 없음(결과가 삭제되었거나 개인정보를 가려 보관)</dd>
            <dt>의견 내용</dt>
            <dd v-if="g13">지금은 볼 수 없음 - 개인정보를 가리는 중</dd>
            <dd v-else-if="detail.opinionDeid"><C8Masked :text="detail.opinionDeid" /></dd>
            <dd v-else class="muted">적은 의견 없음</dd>
          </dl>
        </div>
        <C2GateBlock v-if="g13" :gate="g13" />
        <fieldset class="card m-0">
          <legend class="t-body-sm-strong">이 의견이 맞나요?</legend>
          <div class="row mt-sm">
            <label v-for="(label, k) in REVIEW_DECISION" :key="k" class="choice"><input v-model="decision" type="radio" name="decision" :value="k" /> {{ label }}</label>
          </div>
        </fieldset>
        <p v-if="msg" role="status" class="t-body-sm">{{ msg }}</p>
        <div class="row">
          <C3ReasonButton label="검토 결과 저장" :reason="saveReason" :busy="busy === 'save'" @click="save" />
          <C3ReasonButton label="평가 데이터 후보로 넘기기" :reason="candReason" :busy="busy === 'cand'" @click="candidate" />
        </div>
      </section>
      <D1SourceDrawer :open="drawerOpen" :evidence="drawerEv" :opener="opener" @close="drawerOpen = false" />
    </template>
  </div>
</template>
