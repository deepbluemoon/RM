<script setup lang="ts">
// S0 근거 데이터 갱신 (SD_02 §4) — T134. 운영자 전용. 주 CTA = "반영 승인 - 새 지식 기준일 생성".
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { gateFromCode, toGateView, type GateView } from '@/lib/gates'
import { AGENCY, CHANGE_KIND, DECISION_LABEL } from '@/lib/labels'
import { ymd } from '@/lib/format'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import type { ApproveResult, IngestBatch, IngestItem, KnowledgeVersion } from '@/api/types'

const route = useRoute()
const router = useRouter()
const versions = ref<KnowledgeVersion[]>([])
const batchId = ref<number | null>(Number(route.query.batch) || null)
const batch = ref<IngestBatch | null>(null)
const pageGate = ref<GateView | null>(null)
const actionGate = ref<GateView | null>(null)
const busy = ref<string | null>(null)
const failed = ref<string | null>(null)
const approveOpen = ref(false)
const approved = ref<ApproveResult | null>(null)
const holdNote = ref<number | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null

const active = computed(() => versions.value.find((v) => v.status === 'active') ?? null)

async function loadVersions() {
  try {
    versions.value = await api.knowledgeVersions()
  } catch (e) {
    if (e instanceof GateApiError) pageGate.value = toGateView(e.body)
  }
}
async function loadBatch() {
  if (!batchId.value) return
  try {
    batch.value = await api.ingestBatch(batchId.value)
    if (batch.value.stage === 'collecting' || batch.value.stage === 'preprocessing') {
      timer = setTimeout(loadBatch, 2000)
    }
  } catch (e) {
    if (e instanceof GateApiError) pageGate.value = toGateView(e.body)
    else failed.value = '근거 자료 업데이트 상태를 불러오지 못했습니다'
  }
}
onMounted(async () => {
  await loadVersions()
  await loadBatch()
})
onUnmounted(() => timer && clearTimeout(timer))

async function start() {
  busy.value = 'start'
  failed.value = null
  try {
    const r = await api.startIngest()
    batchId.value = r.batchId ?? null
    router.replace({ query: { batch: String(batchId.value) } })
    approved.value = null
    await loadBatch()
  } catch (e) {
    if (e instanceof GateApiError) actionGate.value = toGateView(e.body)
    else failed.value = '근거 자료 업데이트를 시작하지 못했습니다 - 다시 시도하세요'
  } finally {
    busy.value = null
  }
}

const STAGE_IDX: Record<string, number> = {
  collecting: 0, collect_failed: 0, preprocessing: 1, selecting: 2, kv_created: 3, impact_identified: 4, deadline_checked: 5,
}
const g0 = computed<GateView | null>(() => {
  const og = batch.value?.openGates?.find((g) => g.gate === 'G0')
  if (og) return toGateView(og)
  if (batch.value?.stage === 'collect_failed') {
    const who = (batch.value.sources ?? []).filter((s) => s.status === 'failed').map((s) => AGENCY[s.agency ?? ''] ?? s.agency)
    return gateFromCode('G0', { reason: `${who.join('·')}에서 바뀐 자료를 받지 못해 새 근거 자료 기준일을 만들 수 없습니다. 지금 기준일을 그대로 씁니다` })
  }
  return null
})
const parseFail = computed(() => (batch.value?.items ?? []).filter((i) => i.decisionLabel === 'excluded_parse_fail'))
const g1 = computed<GateView | null>(() => {
  const og = batch.value?.openGates?.find((g) => g.gate === 'G1')
  if (og) return toGateView(og)
  if (parseFail.value.length) return gateFromCode('G1', { title: `조항 나누기 실패 ${parseFail.value.length}건 - 이번 반영에서 빠집니다` })
  return null
})
const railSteps = computed<RailStep[]>(() => {
  const labels = ['자료 가져오기', '조항 나누기', '반영할 항목 고르기', '새 기준일 만들기', '영향받는 결과', '반영 기한 확인']
  const idx = approved.value ? 6 : batch.value ? STAGE_IDX[batch.value.stage ?? 'collecting'] : -1
  return labels.map((label, i) => {
    if (i === 0 && g0.value) return { label, state: 'block', gate: 'G0' }
    if (idx < 0) return { label, state: 'wait' }
    return { label, state: i < idx ? 'done' : i === idx ? 'now' : 'wait' }
  })
})

async function toggle(item: IngestItem, include: boolean) {
  if (!batchId.value || item.itemId == null) return
  if (include && item.decisionLabel === 'hold_not_effective') holdNote.value = item.itemId
  busy.value = `item-${item.itemId}`
  try {
    await api.setIngestItem(batchId.value, item.itemId, include)
    item.include = include
  } catch (e) {
    if (e instanceof GateApiError) actionGate.value = toGateView(e.body)
    else failed.value = '반영할지 여부를 저장하지 못했습니다 - 다시 시도하세요'
  } finally {
    busy.value = null
  }
}

async function retry() {
  if (!batchId.value) return
  busy.value = 'retry_collect'
  try {
    await api.retryIngest(batchId.value)
    await loadBatch()
  } catch {
    failed.value = '자료를 다시 가져오지 못했습니다'
  } finally {
    busy.value = null
  }
}

const approveReason = computed<DisabledReason | null>(() => {
  if (g0.value) return { gate: 'G0', text: g0.value.title }
  if (approved.value) return { text: '이미 새 근거 자료 기준일을 만들었습니다' }
  if (!batch.value) return { text: '먼저 "업데이트 시작"을 누르세요' }
  if (batch.value.stage !== 'selecting') return { text: '반영할 항목을 고르는 단계가 되어야 승인할 수 있습니다' }
  return null
})
async function approve() {
  if (!batchId.value) return
  busy.value = 'approve'
  try {
    approved.value = await api.approveIngest(batchId.value)
    approveOpen.value = false
    await Promise.all([loadVersions(), loadBatch()])
  } catch (e) {
    approveOpen.value = false
    if (e instanceof GateApiError) actionGate.value = toGateView(e.body)
    else failed.value = '승인하지 못했습니다 - 다시 시도하세요'
  } finally {
    busy.value = null
  }
}
function onGate(a: string) {
  if (a === 'retry_collect') void retry()
  else if (a === 'open_review_list') document.getElementById('items-h')?.scrollIntoView({ block: 'start' })
}
const deadlineItems = computed(() => (batch.value?.items ?? []).filter((i) => (i.elapsedDays ?? 0) >= 5))
</script>

<template>
  <div class="page">
    <div v-if="pageGate" class="section tight"><C2GateBlock :gate="pageGate" full @action="router.push('/')" /></div>
    <template v-else>
      <C1Rail :label="`근거 자료 업데이트${batchId ? ` · 작업 번호 ${batchId}` : ''}`" :steps="railSteps" />
      <div class="page-head">
        <h1 class="t-display-lg">근거 자료 관리</h1>
        <p class="t-body-sm charcoal">분석에 쓰는 법령 · 공정위 사례 · 표준약관을 최신으로 바꾸는 화면입니다. 운영자는 새로 들어온 항목 가운데 반영할 것을 고르고 승인해 새 근거 자료 기준일을 만듭니다.</p>
        <div class="band" role="note">
          <span>지금 쓰는 근거 자료 기준일 <strong>{{ active ? ymd(active.knowledgeDate) : '없음' }}</strong><template v-if="active?.analysisBasisVersion"> · 분석 기준 버전 {{ active.analysisBasisVersion }}</template></span>
          <span>이미 진행 중인 분석은 원래 기준일로 끝까지 진행됩니다</span>
        </div>
        <p v-if="failed" role="alert" class="t-body-sm">{{ failed }}</p>
      </div>

      <section v-if="!batch" class="section tight">
        <button type="button" class="btn btn-secondary" :aria-busy="busy === 'start' ? 'true' : undefined" @click="start">업데이트 시작</button>
        <p class="t-body-sm muted">지금 기준일 이후에 4개 기관(국가법령정보센터 · 공정거래위원회 · 공공데이터포털 · 한국소비자원)에서 바뀐 자료를 가져옵니다. 가져온 뒤 반영할 항목을 직접 고르게 됩니다.</p>
      </section>

      <template v-else>
        <section class="section tight card" aria-labelledby="src-h">
          <h2 id="src-h" class="t-heading-sm">1. 기관별 자료 가져오기 결과</h2>
          <div class="tablewrap">
            <table class="spec">
              <thead><tr><th>기관</th><th>결과</th><th>실패 이유</th></tr></thead>
              <tbody>
                <tr v-for="s in batch.sources ?? []" :key="s.agency">
                  <td>{{ AGENCY[s.agency ?? ''] ?? s.agency }}</td>
                  <td>{{ s.status === 'ok' ? '✓ 성공' : '실패' }}</td>
                  <td>{{ s.failReason ?? '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <C7AreaPlaceholder v-if="batch.stage === 'collecting'" kind="processing" text="자료를 가져오는 중" />
        </section>

        <section v-if="g0" class="section tight"><C2GateBlock :gate="g0" :busy-action="busy" @action="onGate" /></section>
        <section v-if="actionGate" class="section tight"><C2GateBlock :gate="actionGate" @action="onGate" /></section>

        <section class="section tight card" aria-labelledby="items-h">
          <h2 id="items-h" class="t-heading-sm">2. 반영할 항목 고르기</h2>
          <p class="t-body-sm charcoal">체크한 항목만 새 기준일에 반영됩니다. 폐지되었거나 조항을 나누지 못한 항목은 고를 수 없습니다.</p>
          <C7AreaPlaceholder v-if="batch.stage === 'preprocessing'" kind="processing" text="자료를 정리하는 중 - 법령은 조·항·호로, 사례는 무슨 일이 있었나 · 공정위 판단 · 판단한 이유로 나눕니다" />
          <div class="tablewrap">
            <table class="spec">
              <thead><tr><th>반영</th><th>항목</th><th>기관</th><th>바뀐 종류</th><th>처리 제안</th><th>공개 후 지난 날</th></tr></thead>
              <tbody>
                <tr v-for="it in batch.items ?? []" :key="it.itemId" :data-item="it.itemId">
                  <td>
                    <label class="row gap-xs">
                      <input
                        type="checkbox"
                        :checked="!!it.include"
                        :disabled="it.decisionLabel === 'excluded_parse_fail' || it.decisionLabel === 'excluded_repealed' || batch.stage !== 'selecting' || !!approved"
                        :aria-describedby="it.decisionLabel === 'excluded_parse_fail' ? `why-${it.itemId}` : undefined"
                        @change="toggle(it, ($event.target as HTMLInputElement).checked)"
                      />
                      <span class="visually-hidden">{{ it.itemTitle }} 반영</span>
                    </label>
                    <span v-if="it.decisionLabel === 'excluded_parse_fail'" :id="`why-${it.itemId}`" class="reason"><b>G1</b>조항을 나누지 못해 반영할 수 없음</span>
                  </td>
                  <td>{{ it.itemTitle }}<p v-if="holdNote === it.itemId" class="t-caption-sm m-0 mt-xs">법이 시행되는 날 이후에 반영됩니다</p></td>
                  <td>{{ AGENCY[it.agency ?? ''] ?? it.agency }}</td>
                  <td>{{ CHANGE_KIND[it.changeKind ?? ''] ?? it.changeKind }}</td>
                  <td>{{ DECISION_LABEL[it.decisionLabel ?? ''] ?? it.decisionLabel }}</td>
                  <td>{{ it.elapsedDays ?? '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="g1" class="section tight"><C2GateBlock :gate="g1" :autofocus="false" @action="onGate" /></section>

        <section v-if="deadlineItems.length" class="section tight card" aria-labelledby="dl-h">
          <h2 id="dl-h" class="t-heading-sm">3. 반영이 늦어진 항목</h2>
          <ul class="bullets">
            <li v-for="it in deadlineItems" :key="it.itemId">{{ it.itemTitle }} : 공개된 지 {{ it.elapsedDays }}일 지남 - 7일 안에 반영해야 합니다</li>
          </ul>
        </section>

        <section v-if="approved" class="section tight card strong" role="status">
          <h2 class="t-heading-sm">새 근거 자료 기준일을 만들었습니다</h2>
          <p class="t-body-sm charcoal">
            근거 자료 기준일 {{ ymd(approved.knowledgeVersion?.knowledgeDate) }} · 바뀐 근거 때문에 다시 볼 필요가 있는 기존 결과 {{ approved.impactedResultCount ?? 0 }}건
          </p>
          <ul v-if="approved.deadlineWarnings?.length" class="bullets">
            <li v-for="w in approved.deadlineWarnings" :key="w.itemId">항목 {{ w.itemId }} : 공개된 지 {{ w.elapsedDays }}일 지남</li>
          </ul>
          <RouterLink to="/admin/eval" class="btn btn-secondary">품질 점검 시작하기</RouterLink>
        </section>

        <section class="section tight row">
          <button v-if="batch.stage === 'deadline_checked' || approved" type="button" class="btn btn-secondary" @click="start">새 업데이트 시작</button>
          <C3ReasonButton label="반영 승인 - 새 근거 자료 기준일 만들기" primary :reason="approveReason" :busy="busy === 'approve'" @click="approveOpen = true" />
        </section>
      </template>

      <ConfirmDialog
        :open="approveOpen"
        :busy="busy === 'approve'"
        title="반영을 승인할까요?"
        message="새 근거 자료 기준일은 승인한 뒤 시작되는 분석부터 쓰입니다. 이미 진행 중인 분석은 원래 기준일로 끝까지 진행됩니다."
        confirm-label="반영 승인"
        @confirm="approve"
        @cancel="approveOpen = false"
      />
    </template>
  </div>
</template>
