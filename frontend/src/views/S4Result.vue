<script setup lang="ts">
// S4 결과 조회·설명 열람 (SD_02 §8) — T087·T096·T104·T111·T121·T127
// 뷰는 요청의 관점으로 정한다(U7). 새 분석은 사업자 고정이라 S4-B, 이전에 만든 소비자 요청만 S4-C 로 열린다. 관점 전환 조작 없음.
// 어두운 반전 면을 쓰지 않는다(가이드 §5.1). 결과를 바꾸는 조작은 "분석 불가" 조항 다시 분석뿐.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { useResultStore, type ResultTab } from '@/stores/result'
import { gateFromCode, toGateView, type GateView } from '@/lib/gates'
import { CATEGORY, CHANGE_KIND, CONTRACT_TYPE, RISK_LEVEL, SOURCE_TYPE } from '@/lib/labels'
import { ymd, ymdhm, evidenceName } from '@/lib/format'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import C4BasisBand from '@/components/common/C4BasisBand.vue'
import C5VerdictBadge from '@/components/common/C5VerdictBadge.vue'
import C6EvidenceChip from '@/components/common/C6EvidenceChip.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import C9ImpactBand from '@/components/common/C9ImpactBand.vue'
import D1SourceDrawer from '@/components/common/D1SourceDrawer.vue'
import DeleteConfirm from '@/components/common/DeleteConfirm.vue'
import ExplanationTab from '@/components/result/ExplanationTab.vue'
import ComparisonView from '@/components/result/ComparisonView.vue'
import CaseView from '@/components/result/CaseView.vue'
import S5FeedbackPanel from './S5FeedbackPanel.vue'
import type { ClauseNode, Comparison, Evidence, Explanation, FtcCase, ResultImpact } from '@/api/types'

const props = defineProps<{ runId: string }>()
const store = useResultStore()
const route = useRoute()
const router = useRouter()
const rid = computed(() => Number(props.runId))

onMounted(async () => {
  await store.load(rid.value)
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = store.listScrollTop
  const first = store.riskList[0]
  // 처음 열 때는 첫 조항만 고르고 스크롤하지 않는다 — 스크롤하면 제목 · '법률 자문 아님' 안내 · 요약이 첫 화면에서 가려졌다(2026-09-30)
  if (store.selectedId == null && first) void selectClause(first.assessmentId, { focus: false, scroll: false })
})
watch(rid, (v) => store.load(v))
// 원문 옆 근거(2026-10-01) — 위험 조항의 판단 · 근거를 뒤에서 미리 받아 원문 바로 옆에 보인다(문서를 바꾸면 그 문서 것)
watch(() => store.riskList.map((c) => c.assessmentId).join(','), () => void store.prefetchDetails(store.riskList.map((c) => c.assessmentId)), { immediate: true })
const NOTE_EVIDENCE_MAX = 3
const noteDetail = (c: ClauseNode) => store.details[c.assessmentId] ?? null
// 근거 칸 이름표(2026-10-01) — 원문이 길면 옆 칸이 어느 조항 것인지 헷갈렸다 → '제12조 1항 근거'처럼 조 · 항 · 호를 맨 위에
const noteFor = (c: ClauseNode) => [c.articleNo, c.paragraphNo, c.itemNo].filter(Boolean).join(' ') || `조항 ${c.seq}`

const r = computed(() => store.result)
const business = computed(() => r.value?.perspective === 'business')
const revisit = computed(() => route.query.from === 'history')

// ---- 레일 — 끝난 세 단계는 눌러서 무엇을 했는지 본다(2026-10-01): 넣은 파일과 첫 몇 줄 · 개인정보 가린 곳 · 조항 수 · 위험도별 개수
const MASK_RE = /〔[^〕]+〕/g
const railSteps = computed<RailStep[]>(() => {
  const res = r.value
  const docs = res?.documents ?? []
  const clauses = res?.clauses ?? []
  const masked = clauses.reduce((n, c) => n + (c.text.match(MASK_RE)?.length ?? 0), 0)
  const c = res?.counts ?? {}
  const cut = (t: string) => (t.length > 90 ? `${t.slice(0, 90)}…` : t)
  const first = clauses.filter((x) => !docs.length || x.documentId === docs[0]?.documentId).slice(0, 4)
  return [
    {
      label: '계약서 넣기',
      state: 'done',
      info: {
        title: '넣은 계약서',
        lines: docs.map((d) => `**${d.displayName ?? '이름 없는 문서'}**${d.contractType ? ` · 계약 유형 ${CONTRACT_TYPE[d.contractType]}` : ''}${d.sourceUrl ? ` · 웹페이지에서 가져옴` : ''}`),
        preview: first.map((x) => cut([x.articleNo, x.paragraphNo].filter(Boolean).join(' ') ? `${[x.articleNo, x.paragraphNo].filter(Boolean).join(' ')} ${x.text}` : x.text)),
        previewLabel: '파일 첫 부분(개인정보는 가린 채로)',
      },
    },
    {
      label: '개인정보 가리기·조항 나누기',
      state: 'done',
      info: {
        title: '개인정보 가리기 · 조항 나누기',
        lines: [
          masked ? `개인정보 **${masked}곳**을 〔이름〕처럼 종류만 남기고 가렸어요` : '가릴 개인정보를 찾지 못했어요',
          `조항 **${clauses.length}개**로 나눴어요${docs.some((d) => d.splitMethod === 'semantic') ? '(번호가 없어 내용 단위로)' : '(제○조 · 항 · 호 번호대로)'}`,
          ...(docs.length > 1 ? [`계약 **${docs.length}건**을 하나씩 나눠 분석했어요`] : []),
          '분석 서버에는 가린 글만 보냈어요',
        ],
      },
    },
    {
      label: '위험 조항 찾기',
      state: 'done',
      info: {
        title: '위험 조항 찾기',
        lines: [
          `조항 **${clauses.length}개**를 모두 살펴봤어요`,
          `위험해 보이는 조항 **${(c.high ?? 0) + (c.mid ?? 0) + (c.low ?? 0)}개** — 높음 **${c.high ?? 0}** · 중간 **${c.mid ?? 0}** · 낮음 **${c.low ?? 0}**`,
          ...((c.unanalyzable ?? 0) ? [`판단이 어려운 조항 **${c.unanalyzable}개**`] : []),
          `근거 자료 기준일 **${res ? ymd(res.knowledgeDate) : '—'}**`,
        ],
      },
    },
    { label: '결과', state: 'now' },
  ]
})

// ---- 위험도별 개수 / 0건(A7)
const counts = computed(() => r.value?.counts ?? {})
const riskTotal = computed(() => (counts.value.high ?? 0) + (counts.value.mid ?? 0) + (counts.value.low ?? 0))
const lowOcr = computed(() => store.docClauses.some((c) => c.lowOcrQuality))
const activeDoc = computed(() => r.value?.documents?.find((d) => d.documentId === store.activeDocId) ?? r.value?.documents?.[0] ?? null)

// ---- 원문(조 단위로 묶기)
const articles = computed(() => {
  const groups: { key: string; head: string; clauses: ClauseNode[] }[] = []
  for (const c of store.docClauses) {
    const head = [c.articleNo, c.title].filter(Boolean).join(' ') || ''
    const key = c.articleNo ?? `seq-${c.seq}`
    const last = groups[groups.length - 1]
    if (last && last.key === key && c.articleNo) last.clauses.push(c)
    else groups.push({ key, head, clauses: [c] })
  }
  return groups
})
const isRiskClause = (c: ClauseNode) => c.displayCategory !== 'normal'
function clauseLabel(c: ClauseNode) {
  return [c.articleNo, c.paragraphNo, c.itemNo, c.title].filter(Boolean).join(' ') || `조항 ${c.seq}`
}

// ---- 선택(목록 ↔ 원문 양방향, 4.3)
const listEl = ref<HTMLElement | null>(null)
const sourceEl = ref<HTMLElement | null>(null)
function onListScroll() {
  if (listEl.value) store.listScrollTop = listEl.value.scrollTop
}
async function selectClause(id: number, opts: { focus?: boolean; from?: 'list' | 'source'; scroll?: boolean } = {}) {
  await store.select(id)
  void loadTabData()
  await nextTick()
  if (opts.from !== 'source') {
    const el = sourceEl.value?.querySelector<HTMLElement>(`[data-assessment="${id}"]`)
    if (opts.scroll !== false) el?.scrollIntoView?.({ block: 'center' })
    if (opts.focus !== false) el?.focus()
  }
  if (opts.from !== 'list' && opts.scroll !== false) {
    listEl.value?.querySelector<HTMLElement>(`[data-list-item="${id}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }
}

// ---- 탭 데이터(설명·비교·사례) — 조항별 캐시
const explanations = ref<Record<number, Explanation | null>>({})
const comparisons = ref<Record<number, Comparison | null>>({})
const casesMap = ref<Record<number, FtcCase[] | null>>({})
const tabLoading = ref(false)
async function loadTabData() {
  const id = store.selectedId
  if (id == null || !r.value) return
  const c = store.selected
  if (!c || c.displayCategory === 'unanalyzable' || c.displayCategory === 'normal') return
  tabLoading.value = true
  try {
    const jobs: Promise<unknown>[] = []
    if (!(id in explanations.value))
      jobs.push(api.explanation(rid.value, id).then((x) => (explanations.value = { ...explanations.value, [id]: x })).catch(() => (explanations.value = { ...explanations.value, [id]: { available: false, perspective: r.value!.perspective } })))
    if (store.activeTab === 'compare' && !(id in comparisons.value))
      jobs.push(api.comparison(rid.value, id).then((x) => (comparisons.value = { ...comparisons.value, [id]: x })).catch(() => (comparisons.value = { ...comparisons.value, [id]: {} })))
    if (store.activeTab === 'cases' && !(id in casesMap.value))
      jobs.push(api.similarCases(rid.value, id).then((x) => (casesMap.value = { ...casesMap.value, [id]: x })).catch(() => (casesMap.value = { ...casesMap.value, [id]: [] })))
    await Promise.all(jobs)
  } finally {
    tabLoading.value = false
  }
}
watch(() => store.activeTab, () => void loadTabData())

const sel = computed(() => store.selected)
const det = computed(() => store.selectedDetail)
const expl = computed(() => (store.selectedId != null ? explanations.value[store.selectedId] ?? null : null))
const g9 = computed<GateView | null>(() => {
  const e = expl.value
  if (!e) return null
  if (e.gate) return toGateView(e.gate, { nextActions: [{ id: 'show_evidence', label: '근거 목록 보기' }, { id: 'feedback', label: '의견 보내기' }] })
  if (!e.available) return gateFromCode('G9', { nextActions: [{ id: 'show_evidence', label: '근거 목록 보기' }, { id: 'feedback', label: '의견 보내기' }] })
  return null
})
const unanalyzable = computed(() => sel.value?.displayCategory === 'unanalyzable')
const noVerdictTabs = computed(() => unanalyzable.value || sel.value?.displayCategory === 'normal')

const tabs = computed<{ id: ResultTab; label: string; reason?: string }[]>(() => [
  { id: 'verdict', label: '판단 · 근거' },
  {
    id: 'explain',
    label: business.value ? '검토 포인트' : '쉬운 설명',
    reason: noVerdictTabs.value ? '위험하다고 판단한 조항에서만 볼 수 있어요' : g9.value ? '지금은 설명을 보여 드릴 수 없어요' : undefined,
  },
  { id: 'compare', label: business.value ? '표준약관과 다른 점' : '비교 보기', reason: noVerdictTabs.value ? '위험하다고 판단한 조항에서만 볼 수 있어요' : undefined },
  { id: 'cases', label: '비슷한 사례', reason: noVerdictTabs.value ? '위험하다고 판단한 조항에서만 볼 수 있어요' : undefined },
])
function pickTab(t: { id: ResultTab; reason?: string }) {
  if (t.reason) return
  store.activeTab = t.id
}
watch(noVerdictTabs, (v) => v && (store.activeTab = 'verdict'))
watch(g9, (g) => g && store.activeTab === 'explain' && (store.activeTab = 'verdict'))

// ---- D1 드로어
const drawerOpen = ref(false)
const drawerEv = ref<Evidence | null>(null)
const opener = ref<HTMLElement | null>(null)
function openEvidence(ev: Evidence, el: HTMLElement) {
  drawerEv.value = ev
  opener.value = el
  drawerOpen.value = true
}

// ---- 분석 불가 조항 다시 분석(4.5) — G5 면 조항 안 C2
const rejudging = ref(false)
const recheckBusy = ref(false)
const detailGate = computed(() => (store.selectedId != null ? store.detailGate[store.selectedId] ?? null : null))
const rejudgeReason = computed<DisabledReason | null>(() => (detailGate.value ? { gate: detailGate.value.gate, text: detailGate.value.title } : null))
async function rejudge() {
  if (store.selectedId == null) return
  rejudging.value = true
  try {
    await store.rejudge(store.selectedId)
  } finally {
    rejudging.value = false
  }
}
async function onDetailGate(action: string) {
  if (action === 'recheck_status' && store.selectedId != null) {
    recheckBusy.value = true
    try {
      const s = await api.modelServerStatus()
      if (s.state !== 'unreachable') store.clearDetailGate(store.selectedId)
    } catch {
      /* 그대로 유지 */
    } finally {
      recheckBusy.value = false
    }
  }
}

// ---- G9 블록 행동
const chipsEl = ref<HTMLElement | null>(null)
function onG9(action: string) {
  if (action === 'show_evidence') chipsEl.value?.querySelector<HTMLElement>('.chip')?.focus()
  else if (action === 'feedback') openFeedback()
}

// ---- C9 근거 변경
const impacts = ref<ResultImpact[] | null>(null)
async function viewImpacts() {
  impacts.value = await api.impacts(rid.value).catch(() => [])
}
function goReanalyze() {
  router.push({ path: '/history', query: { requestId: String(r.value?.requestId ?? '') } })
}

// ---- S5 피드백
const fbOpen = ref(false)
function openFeedback() {
  fbOpen.value = true
}
function focusSelectedClause() {
  const id = store.selectedId
  if (id != null) sourceEl.value?.querySelector<HTMLElement>(`[data-assessment="${id}"]`)?.focus()
}

// ---- 결과 관리: 삭제(T111)
const menuOpen = ref(false)
// 결과 관리 메뉴(2026-09-30) — 열면 첫 항목으로 초점, Esc(버튼 · 항목 어디서든) 또는 바깥을 누르면 닫는다. Esc 로 닫으면 초점은 버튼으로
const menuWrap = ref<HTMLElement | null>(null)
const menuBtn = ref<HTMLButtonElement | null>(null)
function closeResultMenu(returnFocus = true) {
  if (!menuOpen.value) return
  menuOpen.value = false
  if (returnFocus) menuBtn.value?.focus()
}
function onOutside(e: PointerEvent) {
  if (menuWrap.value && !menuWrap.value.contains(e.target as Node)) closeResultMenu(false)
}
watch(menuOpen, async (open) => {
  if (open) {
    document.addEventListener('pointerdown', onOutside, true)
    await nextTick()
    menuWrap.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  } else document.removeEventListener('pointerdown', onOutside, true)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
const delOpen = ref(false)
const deleting = ref(false)
const delFailed = ref(false)
const deleted = ref(false)
async function doDelete() {
  if (!r.value) return
  deleting.value = true
  delFailed.value = false
  try {
    await api.deleteHistory(r.value.requestId)
    delOpen.value = false
    deleted.value = true
  } catch {
    delFailed.value = true
  } finally {
    deleting.value = false
  }
}

function onAccessGate(action: string) {
  if (action.includes('history')) router.push('/history')
  else router.push('/')
}
</script>

<template>
  <div class="page">
    <!-- 접근 거부(G8) — 화면 전체 대체 -->
    <div v-if="store.gate" class="section tight">
      <C2GateBlock :gate="store.gate" full @action="onAccessGate" />
    </div>
    <div v-else-if="deleted" class="section tight">
      <C7AreaPlaceholder kind="na" text="결과를 완전히 지웠어요. 이 결과에 남긴 의견은 누가 썼는지 알 수 없게 바꿔서만 남겨 둬요.">
        <p class="mt-md"><RouterLink to="/" class="btn btn-secondary">새 분석 시작</RouterLink></p>
      </C7AreaPlaceholder>
    </div>
    <div v-else-if="!r" class="section tight">
      <C7AreaPlaceholder v-if="store.failed" kind="unavailable" text="결과를 불러오지 못했어요. 새로 고침해서 다시 시도해 주세요" />
      <C7AreaPlaceholder v-else kind="processing" text="결과를 불러오고 있어요" />
    </div>

    <template v-else>
      <!-- 펼친 내용이 따라다니며 본문을 가리지 않게 레일은 고정하지 않는다 -->
      <C1Rail :steps="railSteps" :sticky="false" />

      <div class="page-head row between items-end">
        <div>
          <h1 class="t-display-lg">분석 결과</h1>
          <p class="t-body-sm muted m-0 mt-xs" :data-view="business ? 'S4-B' : 'S4-C'">
            {{ business ? '사업자 입장에서 봤어요 — 우리 약관에서 무엇을 고치면 좋을지' : '소비자 입장에서 봤어요 — 나에게 무엇이 불리한지' }}
          </p>
        </div>
        <div ref="menuWrap" class="menu" @keydown.esc.stop="closeResultMenu()">
          <button ref="menuBtn" type="button" class="btn btn-secondary" aria-haspopup="menu" :aria-expanded="menuOpen ? 'true' : 'false'" data-action="result-menu" @click="menuOpen = !menuOpen">결과 관리</button>
          <Transition name="pop">
            <div v-if="menuOpen" class="menu-pop" role="menu">
              <button type="button" role="menuitem" data-action="delete" @click="menuOpen = false; delOpen = true">결과 삭제</button>
            </div>
          </Transition>
        </div>
      </div>

      <div class="stack mt-lg">
        <!-- 고지 문구는 SD_02 C4 고정 문구(컴포넌트 기본값) — 응답 disclaimer 는 계약상 참고 문자열 -->
        <C4BasisBand
          :knowledge-date="r.knowledgeDate"
          :perspective="r.perspective"
          :variant="r.runKind === 'reanalysis' ? 'reanalysis' : revisit ? 'revisit' : 'default'"
        />
        <C9ImpactBand :impact="r.impactNotice" @view="viewImpacts" @reanalyze="goReanalyze" />
        <div v-if="impacts" class="card">
          <h3>분석한 뒤에 바뀐 근거 자료</h3>
          <C7AreaPlaceholder v-if="!impacts.length" kind="na" text="바뀐 내용이 없어요" />
          <div v-else class="tablewrap">
            <table class="spec">
              <thead><tr><th>무엇이 바뀌었나</th><th>근거 자료</th><th>근거 자료 기준일</th></tr></thead>
              <tbody>
                <tr v-for="(i, k) in impacts" :key="k"><td>{{ CHANGE_KIND[i.changeKind ?? ''] ?? i.changeKind }}</td><td>{{ evidenceName(i.sourceName, i.identifier) }}</td><td>{{ ymd(i.knowledgeDate) }}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-if="lowOcr" class="band" role="note" data-part="ocr-band">
          <strong>원문 글자가 흐릿해서 결과가 조금 덜 정확할 수 있어요</strong>
          <span>잘 읽히지 않은 조항에는 "글자가 흐릿해요" 표시를 붙였어요</span>
        </div>
      </div>

      <!-- 복수 문서 전환 -->
      <div v-if="store.multiDoc" class="tabs mt-xl" role="tablist" aria-label="문서">
        <button
          v-for="d in r.documents"
          :key="d.documentId"
          type="button"
          role="tab"
          class="tab"
          :aria-selected="store.activeDocId === d.documentId ? 'true' : 'false'"
          data-part="doc-tab"
          @click="store.activeDocId = d.documentId ?? null"
        >{{ d.displayName }}</button>
      </div>

      <section class="section tight card" aria-labelledby="sum-h">
        <h2 id="sum-h" class="t-heading-sm">계약 요약</h2>
        <p v-if="activeDoc?.contractType" class="t-body-sm charcoal m-0 mt-xs mb-sm">
          계약 유형 {{ CONTRACT_TYPE[activeDoc.contractType] }}
          <template v-if="activeDoc.contractTypeInScope === false"> · 아직 근거 자료가 부족한 계약 종류예요 — 전문가에게도 확인받아 보세요</template>
          <template v-if="activeDoc.splitMethod === 'semantic'"> · 조항 번호가 없어서 내용 흐름에 따라 나눴어요</template>
          <template v-if="activeDoc.sourceUrl"> · 출처 <span class="mono">{{ activeDoc.sourceUrl }}</span> (가져온 시각 {{ ymdhm(activeDoc.collectedAt) }})</template>
        </p>
        <p v-if="activeDoc?.summary" class="t-body-md m-0 pre-line"><C8Masked :text="activeDoc.summary" /></p>
        <C7AreaPlaceholder v-else kind="unavailable" text="요약을 보여 드릴 수 없어요. 아래 원문과 조항별 판단을 직접 확인해 주세요" />
      </section>

      <section class="section tight" aria-label="위험도별 개수">
        <div class="counts" data-part="counts">
          <span class="risk high">위험도 높음 {{ counts.high ?? 0 }}</span>
          <span class="risk mid">위험도 중간 {{ counts.mid ?? 0 }}</span>
          <span class="risk low">위험도 낮음 {{ counts.low ?? 0 }}</span>
          <span class="cat unanalyzable">판단 어려움 {{ counts.unanalyzable ?? 0 }}</span>
        </div>
        <C7AreaPlaceholder class="mt-lg"
          v-if="riskTotal === 0 && !(counts.unanalyzable ?? 0)"
          kind="na"
          text="위험해 보이는 조항을 찾지 못했어요. 다만 법률 자문은 아니니, 중요한 계약이라면 전문가에게도 확인받아 보세요"
        />
      </section>

      <section class="section tight result-grid">
        <div>
          <h2 class="t-body-sm-strong mb-sm" id="list-h">위험한 조항부터</h2>
          <ul ref="listEl" class="risk-list" aria-labelledby="list-h" data-part="risk-list" @scroll="onListScroll">
            <li v-for="c in store.riskList" :key="c.assessmentId">
              <button
                type="button"
                :data-list-item="c.assessmentId"
                :class="`lvl-${c.riskLevel ?? 'none'}`"
                :aria-current="store.selectedId === c.assessmentId ? 'true' : undefined"
                @click="selectClause(c.assessmentId, { from: 'list' })"
              >
                <span class="row gap-sm">
                  <span v-if="c.riskLevel" :class="['risk', c.riskLevel]">{{ RISK_LEVEL[c.riskLevel] }}</span>
                  <span :class="['cat', { unanalyzable: c.displayCategory === 'unanalyzable' }]">{{ c.abstention ? '판단 보류' : CATEGORY[c.displayCategory] }}</span>
                  <span v-if="c.lowOcrQuality" class="ocr-flag">글자가 흐릿해요</span>
                </span>
                <span class="t-body-sm">{{ clauseLabel(c) }}</span>
              </button>
            </li>
            <li v-if="!store.riskList.length" class="t-body-sm muted p-lg">위험 조항이 없어요</li>
          </ul>
        </div>
        <div>
          <h2 class="t-body-sm-strong mb-sm">계약서 원문 (조 · 항 · 호)</h2>
          <div ref="sourceEl" class="source clause" data-part="source" aria-label="원문">
            <template v-for="g in articles" :key="g.key">
              <p v-if="g.head" class="art">{{ g.head }}</p>
              <template v-for="c in g.clauses" :key="c.assessmentId">
                <div v-if="isRiskClause(c)" :class="['clause-row', c.riskLevel ?? 'none', { sel: store.selectedId === c.assessmentId }]">
                <button
                  type="button"
                  :class="['hl', 'clause-line', c.riskLevel ?? '', { sel: store.selectedId === c.assessmentId }]"
                  :data-assessment="c.assessmentId"
                  :aria-label="`${clauseLabel(c)} — ${CATEGORY[c.displayCategory]}${c.riskLevel ? `, 위험도 ${RISK_LEVEL[c.riskLevel]}` : ''}`"
                  :aria-pressed="store.selectedId === c.assessmentId ? 'true' : 'false'"
                  @click="selectClause(c.assessmentId, { from: 'source' })"
                ><span v-if="c.paragraphNo || c.itemNo" class="muted">{{ [c.paragraphNo, c.itemNo].filter(Boolean).join(' ') }} </span><C8Masked :text="c.text" /><span v-if="c.lowOcrQuality" class="ocr-flag">글자가 흐릿해요</span></button>
                <!-- 원문 옆 판단 · 근거(2026-10-01) — 넓은 화면은 오른쪽 칸, 좁은 화면은 조항 바로 아래 -->
                <aside class="clause-note" data-part="clause-note" :aria-label="`${clauseLabel(c)} 판단과 근거`">
                  <span class="note-for" data-part="note-for">{{ noteFor(c) }} 근거</span>
                  <span class="note-head">
                    <span v-if="c.riskLevel" :class="['risk', 'sm', c.riskLevel]">{{ RISK_LEVEL[c.riskLevel] }}</span>
                    <span :class="['cat', 'sm', { unanalyzable: c.displayCategory === 'unanalyzable' }]">{{ c.abstention ? '판단 보류' : CATEGORY[c.displayCategory] }}</span>
                  </span>
                  <template v-if="c.displayCategory === 'unanalyzable'">
                    <span class="note-empty">자동으로 판단하지 못했어요. 눌러서 다시 분석할 수 있어요</span>
                  </template>
                  <template v-else-if="noteDetail(c)">
                    <ul v-if="noteDetail(c)!.evidence.length" class="note-ev">
                      <li v-for="e in noteDetail(c)!.evidence.slice(0, NOTE_EVIDENCE_MAX)" :key="e.evidenceVersionId">
                        <button type="button" class="note-ev-btn" :data-evidence="e.evidenceVersionId" @click="openEvidence(e, $event.currentTarget as HTMLElement)">
                          <small>{{ SOURCE_TYPE[e.sourceType] ?? e.sourceType }}</small><span>{{ evidenceName(e.sourceName, e.identifier) }}</span>
                        </button>
                      </li>
                      <li v-if="noteDetail(c)!.evidence.length > NOTE_EVIDENCE_MAX" class="note-more">근거 {{ noteDetail(c)!.evidence.length - NOTE_EVIDENCE_MAX }}개 더 — 조항을 누르면 아래에서 모두 볼 수 있어요</li>
                    </ul>
                    <span v-else class="note-empty">근거를 못 찾았어요. 직접 한번 살펴봐 주세요</span>
                  </template>
                  <span v-else class="note-empty" aria-live="off">근거를 불러오고 있어요…</span>
                </aside>
                </div>
                <span v-else class="clause-line" :data-assessment="c.assessmentId" tabindex="-1"><span v-if="c.paragraphNo || c.itemNo" class="muted">{{ [c.paragraphNo, c.itemNo].filter(Boolean).join(' ') }} </span><C8Masked :text="c.text" /><span v-if="c.lowOcrQuality" class="ocr-flag">글자 인식 품질 낮음</span></span>
              </template>
            </template>
          </div>
        </div>
      </section>

      <!-- 판정 상세 -->
      <section v-if="sel" id="detail" class="section tight detail" aria-labelledby="detail-h" data-part="detail">
        <div class="row between mb-lg">
          <h2 id="detail-h" class="t-heading-md">{{ clauseLabel(sel) }}</h2>
          <button type="button" class="btn btn-secondary" data-action="feedback" @click="openFeedback">이 판단에 의견 보내기</button>
        </div>
        <div class="tabs" role="tablist" aria-label="조항 자세히 보기">
          <button
            v-for="t in tabs"
            :key="t.id"
            type="button"
            role="tab"
            class="tab"
            :data-tab="t.id"
            :aria-selected="store.activeTab === t.id ? 'true' : 'false'"
            :aria-disabled="t.reason ? 'true' : undefined"
            :title="t.reason"
            @click="pickTab(t)"
          >{{ t.label }}<template v-if="t.reason"> (지금은 볼 수 없어요)</template></button>
        </div>

        <div v-show="store.activeTab === 'verdict'" role="tabpanel" data-panel="verdict" class="stack">
          <C7AreaPlaceholder v-if="!det && store.detailLoading" kind="processing" text="조항 판단 내용을 불러오고 있어요" />
          <template v-else-if="det">
            <template v-if="unanalyzable">
              <C5VerdictBadge category="unanalyzable" :low-ocr-quality="sel.lowOcrQuality" :abstention="sel.abstention ?? null" />
              <template v-if="sel.abstention">
                <!-- 판정 불가: 입력 자체의 문제라 다시 분석해도 같은 결과 — 원문 확인을 안내한다 -->
                <C7AreaPlaceholder kind="unavailable" :text="`${sel.abstention.label}. 그래서 자동으로 판단하지 않았어요. 아래 원문을 직접 확인해 주세요`" />
              </template>
              <template v-else>
                <C7AreaPlaceholder kind="unavailable" text="판단을 내리지 못한 조항이에요. 그래서 판단 · 근거 칸이 비어 있어요" />
                <C2GateBlock v-if="detailGate" :gate="detailGate" :busy-action="recheckBusy ? 'recheck_status' : null" @action="onDetailGate" />
                <C3ReasonButton label="다시 분석" :reason="rejudgeReason" :busy="rejudging" busy-label="분석하고 있어요…" @click="rejudge" />
                <p class="t-caption-sm muted">분석했던 당시의 근거 자료 기준일({{ ymd(r.knowledgeDate) }})로 이 조항 하나만 다시 판단해요.</p>
              </template>
            </template>
            <template v-else>
              <C5VerdictBadge
                :category="det.displayCategory"
                :risk-type="det.riskType"
                :risk-level="det.riskLevel"
                :confidence="det.confidence"
                :evidence-unconfirmed="det.evidenceUnconfirmed"
                :expert-review-recommended="det.expertReviewRecommended"
                :low-ocr-quality="sel.lowOcrQuality"
              />
              <div ref="chipsEl" class="chips" aria-label="근거">
                <span class="t-body-sm muted">근거:</span>
                <C6EvidenceChip v-for="e in det.evidence" :key="e.evidenceVersionId" :evidence="e" @open="openEvidence" />
              </div>
              <C7AreaPlaceholder
                v-if="!det.evidence.length && det.displayCategory !== 'normal'"
                kind="unavailable"
                text="근거를 확인하지 못했어요. 직접 한번 살펴봐 주세요"
              />
              <C2GateBlock v-if="g9" :gate="g9" :autofocus="false" @action="onG9" />
            </template>
          </template>
        </div>

        <div v-if="store.activeTab === 'explain'" role="tabpanel" data-panel="explain">
          <ExplanationTab :explanation="expl" :evidence="det?.evidence ?? []" :perspective="r.perspective" :loading="tabLoading" @open-evidence="openEvidence" />
        </div>
        <div v-if="store.activeTab === 'compare'" role="tabpanel" data-panel="compare">
          <ComparisonView
            :comparison="store.selectedId != null ? comparisons[store.selectedId] ?? null : null"
            :perspective="r.perspective"
            :clause-text="sel.text"
            :loading="tabLoading"
            :evidence-unconfirmed="det?.evidenceUnconfirmed"
          />
        </div>
        <div v-if="store.activeTab === 'cases'" role="tabpanel" data-panel="cases">
          <CaseView :cases="store.selectedId != null ? casesMap[store.selectedId] ?? null : null" :loading="tabLoading" @open-evidence="openEvidence" />
        </div>
      </section>

      <D1SourceDrawer :open="drawerOpen" :evidence="drawerEv" :opener="opener" @close="drawerOpen = false" />
      <S5FeedbackPanel
        :open="fbOpen"
        :clause="sel"
        :detail="det"
        :knowledge-date="r.knowledgeDate"
        :return-focus="focusSelectedClause"
        @close="fbOpen = false"
      />
      <DeleteConfirm :open="delOpen" :busy="deleting" :failed="delFailed" @confirm="doDelete" @cancel="delOpen = false" />
    </template>
  </div>
</template>

<style scoped>
/* 원문 옆 근거 구분(2026-10-01) — 위험 조항 한 줄(원문 + 옆 근거)마다 위아래 가는 선, 붙어 있는 조항끼리는 선 하나를 같이 쓴다 */
.clause-row { margin: 0; padding: 12px 0; border-bottom: 1px solid var(--color-hairline); }
.clause-row:first-child, :not(.clause-row) + .clause-row { border-top: 1px solid var(--color-hairline); margin-top: 6px; }
.clause-row + :not(.clause-row) { margin-top: 6px; }
.note-for { font: 600 12px/1.4 var(--font-sans); color: var(--color-ink); padding-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--color-ink) 12%, transparent); }
</style>
