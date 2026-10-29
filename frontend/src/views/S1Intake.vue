<script setup lang="ts">
// S1 분석 접수·사전검증 (SD_02 §5) — T083·T104·T112·T126
// 비용이 드는 처리 전에, 비용 순서(G2→G3→G5)대로 막는다(U2). 주 CTA = "분석 시작" 1개.
// 로컬 사업자 검증 모드: 로그인·이용 한도 없음, 관점은 사업자로 고정(S4-B 뷰).
// 화면 구성(2026-09-30 줄이기): 머리 = 제목 · 한 줄 설명 | 개인정보 요약(자세히는 접기) → 입력 작업판 한 칸(입력 방식 탭 · 입력 · 시작).
// 서버 상태는 바로 분석할 수 있으면 숨기고, 파일 확인 목록은 파일을 고른 뒤에만 보인다. 예시 문서 칸은 없애고 예시 카드(SampleFilesMotion)로 넣는다.
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { useAnalysisStore } from '@/stores/analysis'
import { toGateView, gateFromCode, type GateView } from '@/lib/gates'
import { bytes, ymdhm } from '@/lib/format'
import { PII_LABELS } from '@/lib/labels'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import C11ModelServerState from '@/components/common/C11ModelServerState.vue'
import SampleFilesMotion from '@/components/common/SampleFilesMotion.vue'
import { vSmoothDetails } from '@/lib/smoothDetails' // 자세히 보기 · 방침 전체 보기 부드럽게 열고 닫기(2026-10-01)
import type { ModelServerStatus, PrecheckItem, PrecheckResult, UrlFetchResult } from '@/api/types'

type Tab = 'file' | 'url' | 'text'
const MAX_BYTES = 50 * 1024 * 1024
const EXT = ['pdf', 'hwp', 'hwpx', 'docx', 'html', 'htm']

const analysis = useAnalysisStore()
const router = useRouter()

const tab = ref<Tab>('file')

// 파일
const fileInput = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const precheck = ref<PrecheckResult | null>(null)
const checks = ref<PrecheckItem[] | null>(null)
const uploading = ref(false)
const fileGate = ref<GateView | null>(null)
const uploadFailed = ref(false)

// URL
const urlText = ref('')
const fetched = ref<UrlFetchResult | null>(null)
const fetching = ref(false)
const urlGate = ref<GateView | null>(null)
const urlFailed = ref(false)

// 텍스트
const text = ref('')

// 시작
const starting = ref(false)
const startGate = ref<GateView | null>(null)
const startFailed = ref(false)

// C11
const ms = ref<ModelServerStatus | null>(null)
const msLoading = ref(false)
const msFailed = ref(false)

const privacyHtml = ref<string | null>(null)
// '자세히 보기'를 닫으면 안의 '개인정보 처리 방침 전체 보기'도 함께 닫는다 — 다시 열었을 때 긴 방침이 펼쳐진 채 나오지 않게
const policyEl = ref<HTMLDetailsElement | null>(null)
function onNoticeToggle(e: Event) {
  if (e.target !== e.currentTarget) return // 안쪽 details 의 toggle 은 무시
  if (!(e.target as HTMLDetailsElement).open && policyEl.value) policyEl.value.open = false
}
// 서버 상태는 할 말이 있을 때만(쉬는 중 · 준비 중 · 연결 안 됨 · 확인 실패) 보인다
const showMs = computed(() => msFailed.value || (!!ms.value && (ms.value.state !== 'ready' || !!ms.value.coldStart)))

async function loadModelStatus() {
  msLoading.value = true
  try {
    ms.value = await api.modelServerStatus()
    msFailed.value = false
    if (startGate.value?.gate === 'G5' && ms.value.state !== 'unreachable') startGate.value = null
  } catch {
    msFailed.value = true
  } finally {
    msLoading.value = false
  }
}

onMounted(async () => {
  void loadModelStatus()
  try {
    const n = await api.privacyNotice()
    privacyHtml.value = n?.html ?? null
  } catch {
    privacyHtml.value = null
  }
})

// ---- 파일 선택 → 즉시 사전 검사(1.3)
const CHECK_LABEL: Record<PrecheckItem['check'], string> = {
  format: '파일 형식(PDF · HWP · HWPX · DOCX · HTML)',
  size: '크기(50MB 이하)',
  pages: '분량(300쪽 이하)',
  encrypted: '암호가 걸려 있지 않음',
  corrupt: '파일이 깨지지 않음',
}
const CHECK_ORDER: PrecheckItem['check'][] = ['format', 'size', 'pages', 'encrypted', 'corrupt']
const checkRows = computed(() =>
  CHECK_ORDER.map((c) => {
    const r = checks.value?.find((x) => x.check === c)
    return { check: c, label: CHECK_LABEL[c], result: r ?? null }
  }),
)

function pickFile() {
  fileInput.value?.click()
}

// 선택한 파일 지우기(파일 놓는 곳 오른쪽 위 X) — 고르기 전 상태로 되돌리고 포커스를 파일 놓는 곳으로 돌린다.
// 사전 검사 중·분석 시작 중에는 버튼을 숨긴다(늦게 도착한 검사 결과가 지운 파일에 붙지 않게).
const dropzoneEl = ref<HTMLElement | null>(null)
function clearFile() {
  file.value = null
  precheck.value = null
  checks.value = null
  fileGate.value = null
  uploadFailed.value = false
  startGate.value = null
  if (fileInput.value) fileInput.value.value = '' // 같은 파일을 다시 골라도 change 가 나도록
  dropzoneEl.value?.focus()
}

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) await handleFile(f)
}

// 고른 파일 카드(2026-10-01) — 형식 표시 · 확인 상태
const fileKind = computed(() => {
  const ext = file.value?.name.split('.').pop()?.toLowerCase() ?? ''
  return EXT.includes(ext) ? (ext === 'htm' ? 'HTML' : ext.toUpperCase()) : '파일'
})
type FileState = 'checking' | 'ready' | 'fail'
const fileState = computed<FileState>(() => (uploading.value ? 'checking' : fileGate.value || uploadFailed.value || !precheck.value ? 'fail' : 'ready'))
// 다 통과하면 오른쪽 '괜찮아요' 다섯 줄(같은 말 반복 · 카드 오른쪽 절반이 빈칸)을 없애고 카드 안 확인 칩으로 줄인다(2026-10-01). 하나라도 어긋나거나 확인 중이면 목록 그대로
const CHECK_SHORT: Record<PrecheckItem['check'], string> = { format: '형식', size: '크기', pages: '분량', encrypted: '암호 없음', corrupt: '깨짐 없음' }
const allPassed = computed(() => fileState.value === 'ready' && checkRows.value.every((r) => r.result?.passed))
// 확인 중에는 카드 상태 줄('확인하고 있어요')만 — 목록을 띄웠다가 통과 순간 없애면 카드 폭이 툭 넓어졌다. 목록은 어긋날 때만
const showCheckList = computed(() => !!file.value && fileState.value === 'fail' && !allPassed.value)
const FILE_STATE_TEXT: Record<FileState, string> = { checking: '파일을 확인하고 있어요…', ready: '분석할 준비가 됐어요', fail: '이 파일은 분석할 수 없어요' }

// 끌어다 놓기 — 파일 선택과 같은 사전 검사로 보낸다
const dragOver = ref(false)
async function onDrop(e: DragEvent) {
  dragOver.value = false
  const f = e.dataTransfer?.files?.[0]
  if (!f) return
  tab.value = 'file'
  await handleFile(f)
}

async function handleFile(f: File) {
  file.value = f
  precheck.value = null
  checks.value = null
  fileGate.value = null
  uploadFailed.value = false
  startGate.value = null
  // 업로드 전에 브라우저가 알 수 있는 것(형식·크기)은 먼저 거른다 — 50MB 초과 파일을 보내지 않는다
  const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
  const localChecks: PrecheckItem[] = []
  if (!EXT.includes(ext)) localChecks.push({ check: 'format', passed: false, message: `이 형식은 아직 읽을 수 없어요(${ext || '확장자 없음'})` })
  if (f.size > MAX_BYTES) localChecks.push({ check: 'size', passed: false, message: bytes(f.size) })
  if (localChecks.length) {
    checks.value = localChecks
    const why = localChecks.map((c) => (c.check === 'size' ? `50MB보다 커요(${c.message})` : c.message)).join(', ')
    fileGate.value = gateFromCode('G2', { reason: why })
    return
  }
  uploading.value = true
  try {
    const r = await api.upload(f)
    precheck.value = r
    checks.value = r.checks
    const failed = r.checks.filter((c) => !c.passed)
    if (failed.length) fileGate.value = gateFromCode('G2', { reason: failed.map((c) => c.message ?? CHECK_LABEL[c.check]).join(', ') })
  } catch (err) {
    if (err instanceof GateApiError) {
      fileGate.value = toGateView(err.body)
      const c = (err.body as { checks?: PrecheckItem[] }).checks ?? (err.body.detail?.checks as PrecheckItem[] | undefined)
      checks.value = c ?? null
    } else uploadFailed.value = true
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

// ---- URL 본문 가져오기(1.4)
async function fetchUrl() {
  if (!urlText.value.trim()) return
  fetching.value = true
  urlGate.value = null
  urlFailed.value = false
  fetched.value = null
  startGate.value = null
  try {
    fetched.value = await api.fetchUrl(urlText.value.trim())
  } catch (err) {
    if (err instanceof GateApiError) urlGate.value = toGateView(err.body)
    else urlFailed.value = true
  } finally {
    fetching.value = false
  }
}

// ---- 게이트 다음 행동
function onGateAction(id: string) {
  if (id === 'recheck_status' || id.includes('status')) return void loadModelStatus()
  if (id === 'choose_other_file' || id === 'reselect_file') return pickFile()
  if (id.includes('text')) {
    tab.value = 'text'
    return
  }
  if (id.includes('file') || id.includes('upload')) {
    tab.value = 'file'
  }
}

// ---- 현재 입력의 게이트·C3 사유
const inputGate = computed<GateView | null>(() => (tab.value === 'file' ? fileGate.value : tab.value === 'url' ? urlGate.value : null))
const g5FromStatus = computed<GateView | null>(() =>
  ms.value?.state === 'unreachable' ? gateFromCode('G5', { reason: '분석 서버가 응답하지 않습니다. 서버가 복구되면 다시 시도해 주세요' }) : null,
)
const shownGate = computed<GateView | null>(() => startGate.value ?? inputGate.value ?? g5FromStatus.value)

const source = computed(() => {
  if (tab.value === 'file' && precheck.value && !fileGate.value) return { kind: 'file' as const, uploadToken: precheck.value.uploadToken }
  if (tab.value === 'url' && fetched.value && !urlGate.value) return { kind: 'url' as const, sourceToken: fetched.value.sourceToken }
  if (tab.value === 'text' && text.value.trim()) return { kind: 'text' as const, text: text.value }
  return null
})

const startReason = computed<DisabledReason | null>(() => {
  if (startGate.value) return { gate: startGate.value.gate, text: startGate.value.title }
  if (tab.value === 'file') {
    if (fileGate.value) return { gate: 'G2', text: '파일이 조건에 맞지 않아요' }
    if (uploading.value) return { text: '파일을 확인하고 있어요' }
    if (!precheck.value) return { text: '먼저 분석할 파일을 골라 주세요' }
  }
  if (tab.value === 'url') {
    if (urlGate.value) return { gate: 'G3', text: '웹페이지 글을 가져오지 못했어요' }
    if (!fetched.value) return { text: '먼저 약관 페이지의 본문을 가져와 주세요' }
  }
  if (tab.value === 'text' && !text.value.trim()) return { text: '먼저 분석할 글을 붙여 넣어 주세요' }
  if (g5FromStatus.value) return { gate: 'G5', text: '지금은 분석할 수 없어요' }
  return null
})


async function startAnalysis() {
  if (!source.value) return
  starting.value = true
  startGate.value = null
  startFailed.value = false
  try {
    const r = await api.createAnalysis('business', source.value)
    analysis.reset()
    router.push(`/analyses/${r.requestId}/structuring`)
  } catch (err) {
    if (err instanceof GateApiError) startGate.value = toGateView(err.body)
    else startFailed.value = true
  } finally {
    starting.value = false
  }
}

// short = 휴대폰(≤560) 탭 이름 — 세 칸이 한 줄에 들어가게. 긴 이름은 display:none 이라 접근 이름도 짧은 쪽이 된다
const tabs: { id: Tab; label: string; short: string; hint: string }[] = [
  { id: 'file', label: '파일 업로드', short: '파일 업로드', hint: '' }, // 형식 안내는 파일 놓는 곳에 있다
  { id: 'url', label: '웹페이지 주소(URL)', short: '웹 주소', hint: '누구나 볼 수 있는 약관 페이지' },
  { id: 'text', label: '텍스트 붙여넣기', short: '글 붙여넣기', hint: '계약서 글을 복사해 그대로 붙여 넣어요' },
]
const currentTab = computed(() => tabs.find((t) => t.id === tab.value)!)
// 입력 방식을 누르면 해당 입력 칸으로 바로 초점을 옮긴다(URL·텍스트).
// 방향키로 탭 사이를 옮길 때는 옮기지 않는다 — 초점이 입력칸으로 빠져 다음 탭으로 못 가던 결함(2026-10-01 측정: → 한 번에 #url-input)
function choose(id: Tab, focusInput = true) {
  tab.value = id
  if (!focusInput) return
  requestAnimationFrame(() => {
    if (id === 'url') document.getElementById('url-input')?.focus()
    if (id === 'text') document.getElementById('text-input')?.focus()
  })
}
function onTabKey(e: KeyboardEvent, i: number) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
  const n = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
  choose(tabs[n].id, false)
  ;(document.getElementById(`tab-${tabs[n].id}`) as HTMLElement | null)?.focus()
}
</script>

<template>
  <div class="intake">
    <section class="hero" aria-labelledby="hero-h">
      <div class="hero-grid">
        <div class="hero-title">
          <p class="hero-kicker" data-part="business-note">사업자 입장에서 보는 계약서 · 약관 검토</p>
          <h1 id="hero-h" class="t-hero">체결 전에,<br>위험한 조항부터.</h1>
        </div>

        <div class="hero-side">
          <p class="lede">계약서나 약관을 넣으면 다툼이나 시정 조치로 이어질 수 있는 조항과 그 이유를 알려 드려요. 보통 1~3분이면 끝나요.</p>
        </div>

        <!-- 개인정보 처리 안내 — 입력 작업판보다 위, 요약은 항상 보이고 전 항목은 '자세히'(FR-010, T112) -->
        <section class="hero-notice" aria-labelledby="privacy-h" data-part="privacy">
          <h2 id="privacy-h">개인정보 처리 안내</h2>
          <p class="notice-sum">개인정보 8가지(주민등록번호 · 계좌번호 · 전화번호 등)는 분석 전에 가리고, 올린 원본은 24시간 안에 지워요.</p>
          <details v-smooth-details class="notice-more" @toggle="onNoticeToggle">
            <summary>자세히 보기</summary>
            <dl class="kv">
              <dt>가리는 정보</dt>
              <dd data-part="pii-types">{{ PII_LABELS.join(' · ') }} — 〔이름〕처럼 종류만 남기고 가려요. 분석 서버에는 가린 글만 보내요</dd>
              <dt>원본 보관</dt>
              <dd>올린 원본 파일은 분석이 끝나고 24시간 안에 지워요</dd>
              <dt>결과 보관</dt>
              <dd>내 계정의 분석 기록에만 남아요. 다른 계정에서는 볼 수 없어요</dd>
              <dt>삭제 방법</dt>
              <dd>결과 화면의 "결과 관리 → 결과 삭제"나 분석 기록의 "기록 삭제"를 누르면 바로, 완전히 지워져요</dd>
              <dt>남긴 의견</dt>
              <dd>결과를 지워도 판단에 남긴 의견은 남아요. 다만 누가 썼는지는 알 수 없게 바꿔 둬요</dd>
            </dl>
            <details v-if="privacyHtml" ref="policyEl" v-smooth-details>
              <summary>개인정보 처리 방침 전체 보기</summary>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div class="t-body-sm" v-html="privacyHtml" />
            </details>
          </details>
        </section>
      </div>
    </section>

    <!-- 입력 작업판 — 한 칸 -->
    <section class="composer-wrap" aria-labelledby="input-h">
      <div class="composer one">
        <div class="composer-main">
          <div class="composer-head">
            <h2 id="input-h" class="visually-hidden">문서 넣기</h2>
            <div class="src-tabs" role="tablist" aria-label="문서를 넣는 방법">
              <button
                v-for="(t, i) in tabs"
                :id="`tab-${t.id}`"
                :key="t.id"
                type="button"
                role="tab"
                class="src-tab"
                :aria-selected="tab === t.id ? 'true' : 'false'"
                :aria-controls="`panel-${t.id}`"
                :tabindex="tab === t.id ? 0 : -1"
                :data-src="t.id"
                @click="choose(t.id)"
                @keydown="onTabKey($event, i)"
              >
                <svg v-if="t.id === 'file'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
                <svg v-else-if="t.id === 'url'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 4h8" /><path d="M9 4v2H7a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2V4" /><path d="M9 11h6M9 15h4" /></svg>
                <span class="lbl-long">{{ t.label }}</span><span class="lbl-short">{{ t.short }}</span>
              </button>
            </div>
            <span v-if="currentTab.hint" class="t-caption-sm muted">{{ currentTab.hint }}</span>
          </div>

          <div v-show="tab === 'file'" id="panel-file" role="tabpanel" aria-labelledby="tab-file" :class="['file-panel', { 'has-file': showCheckList }]">
            <input ref="fileInput" type="file" class="visually-hidden" tabindex="-1" aria-hidden="true" accept=".pdf,.hwp,.hwpx,.docx,.html,.htm" data-part="file-input" @change="onFile" />
            <div class="stack sm">
            <div class="dropzone-wrap">
            <!-- 접근 이름 = 보이는 글(2026-10-01, WCAG 2.5.3) — 고르기 전엔 안내 문장, 고른 뒤엔 파일 이름 · 크기. 설명 = 아래 줄(형식 · 확인 중) -->
            <div
              ref="dropzoneEl"
              :class="['dropzone', { over: dragOver, 'has-file': !!file, [`fc-${fileState}`]: !!file }]"
              role="button"
              tabindex="0"
              aria-labelledby="dz-label"
              aria-describedby="dz-state dz-hint"
              data-part="dropzone"
              @click="pickFile"
              @keydown.enter.prevent="pickFile"
              @keydown.space.prevent="pickFile"
              @dragover.prevent="dragOver = true"
              @dragleave="dragOver = false"
              @drop.prevent="onDrop"
            >
              <!-- 고른 파일 카드(2026-10-01) — 문서 아이콘 + 형식 표시 · 굵은 파일 이름 · 크기 · 쪽수 · 확인 상태(색 + 글자 + 기호) -->
              <template v-if="file">
                <span :key="file.name + file.size" class="fc-doc" aria-hidden="true">
                  <svg viewBox="0 0 40 48" fill="none"><path d="M6 2h20l12 12v30a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="var(--color-canvas)" stroke="currentColor" stroke-width="1.6" /><path d="M26 2v10a2 2 0 0 0 2 2h10" stroke="currentColor" stroke-width="1.6" /><path d="M11 24h18M11 30h18M11 36h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
                  <span class="fc-kind">{{ fileKind }}</span>
                </span>
                <span class="fc-body">
                  <span id="dz-label" class="file-name" data-part="file-meta">{{ file.name }}</span>
                  <span class="fc-meta">{{ bytes(file.size) }}<template v-if="precheck?.pages"> · {{ precheck.pages }}쪽</template> · {{ fileKind }} 문서</span>
                  <span id="dz-state" class="fc-status" data-part="file-state" :data-state="fileState"><i aria-hidden="true" />{{ FILE_STATE_TEXT[fileState] }}</span>
                  <span v-if="allPassed" class="fc-checks" data-part="checks-summary"><span class="visually-hidden">파일 확인 다섯 가지 모두 괜찮아요:</span><span v-for="(r, k) in checkRows" :key="r.check" class="fc-chip" :style="{ animationDelay: `${k * 40}ms` }"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>{{ CHECK_SHORT[r.check] }}</span></span>
                  <span id="dz-hint" class="fc-hint">다른 파일로 바꾸려면 누르거나 끌어다 놓아 주세요</span>
                </span>
              </template>
              <template v-else>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
                <strong id="dz-label">파일을 여기에 끌어다 놓거나, 눌러서 골라 주세요</strong>
                <span id="dz-hint" class="t-body-sm muted">PDF · HWP · HWPX · DOCX · HTML · 50MB · 300쪽까지 · 스캔한 PDF도 글자를 읽어 내요</span>
              </template>
            </div>
            <!-- 파일 놓는 곳(role=button) 안에 넣으면 버튼 안의 버튼이 되므로 형제로 올려 오른쪽 위 구석에 둔다 -->
            <button
              v-if="file && !uploading && !starting"
              type="button"
              class="dropzone-clear"
              aria-label="선택한 파일 지우기"
              title="선택한 파일 지우기"
              data-action="clear-file"
              @click="clearFile"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
            </div>
            <p v-if="uploadFailed" class="t-body-sm m-0" role="alert">파일을 올리지 못했어요. 잠시 뒤 다시 시도해 주세요.</p>
            </div>

            <!-- 파일 확인 — 파일을 고른 뒤에만 -->
            <section v-if="showCheckList" class="file-checks" aria-labelledby="precheck-h">
              <h3 id="precheck-h">파일 확인</h3>
              <p v-if="uploading" class="t-body-sm charcoal m-0" aria-live="polite">형식 · 크기 · 쪽수 · 암호 · 파일 깨짐을 확인하고 있어요</p>
              <ul class="checks" data-part="checks">
                <li v-for="r in checkRows" :key="r.check" :data-check="r.check">
                  <span>{{ r.label }}</span>
                  <span v-if="!r.result" class="muted">{{ uploading ? '확인 중' : fileGate ? '—' : '확인 전' }}</span>
                  <span v-else-if="r.result.passed" class="ok">괜찮아요</span>
                  <span v-else class="fail">맞지 않아요<template v-if="r.result.message"> · {{ r.result.message }}</template></span>
                </li>
              </ul>
            </section>
          </div>

          <div v-show="tab === 'url'" id="panel-url" role="tabpanel" aria-labelledby="tab-url" class="stack">
            <form class="url-row" @submit.prevent="fetchUrl">
              <label for="url-input" class="visually-hidden">약관이 올라온 웹페이지 주소(URL)</label>
              <input id="url-input" v-model="urlText" type="url" class="text-input" placeholder="https://example.com/terms" maxlength="1000" />
              <button type="submit" class="btn btn-secondary btn-lg" :aria-busy="fetching ? 'true' : undefined">{{ fetching ? '가져오고 있어요…' : '본문 가져오기' }}</button>
            </form>
            <p class="t-body-sm muted m-0">로그인 없이 열리는 약관 페이지의 글만 가져올 수 있어요. 파일로 받은 약관이라면 '파일 업로드'를 써 주세요.</p>
            <p v-if="fetched" class="t-body-sm m-0" data-part="url-fetched">
              ✓ 본문을 가져왔어요 · {{ ymdhm(fetched.collectedAt) }} · {{ fetched.charCount.toLocaleString() }}자 · <span class="mono">{{ fetched.sourceUrl }}</span>
            </p>
            <p v-if="urlFailed" class="t-body-sm m-0" role="alert">본문을 가져오지 못했어요. 주소를 확인하고 다시 시도해 주세요.</p>
          </div>

          <div v-show="tab === 'text'" id="panel-text" role="tabpanel" aria-labelledby="tab-text" class="stack sm">
            <label for="text-input" class="t-body-sm-strong">계약서 · 약관 본문</label>
            <textarea id="text-input" v-model="text" class="text-area" maxlength="2000000" placeholder="계약서나 약관 글을 여기에 붙여 넣어 주세요" />
            <p class="t-body-sm muted m-0">붙여 넣은 글은 파일 확인 없이 바로 분석해요<template v-if="text.trim()"> · {{ text.length.toLocaleString() }}자</template>.</p>
          </div>

          <div v-if="shownGate" aria-label="진행할 수 없는 이유">
            <C2GateBlock :key="shownGate.gate + shownGate.reason" :gate="shownGate" :busy-action="msLoading ? 'recheck_status' : null" @action="onGateAction" />
          </div>

          <!-- 분석 서버 상태 — 할 말이 있을 때만 -->
          <section v-if="showMs" class="ms-line" aria-label="분석 서버 상태" data-part="ms-line">
            <C11ModelServerState :status="ms" :loading="msLoading" :failed="msFailed" compact @refresh="loadModelStatus" />
          </section>

          <div class="composer-foot">
            <span class="t-body-sm charcoal flow-line">개인정보 가리기 → 조항 나누기 → 위험 조항 찾기 → 결과</span>
            <C3ReasonButton label="분석 시작" primary :reason="startReason" :busy="starting" busy-label="시작할 수 있는지 확인하고 있어요…" @click="startAnalysis" />
          </div>
          <p v-if="startFailed" class="t-body-sm m-0" role="alert">분석을 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.</p>
          <SampleFilesMotion :active="tab === 'file' && !file && !uploading" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* S1 줄이기(2026-09-30) — 테마(components.css) 규칙은 그대로 두고 여기서만 덮는다. 색·간격은 테마 토큰만 */
.hero{padding-top:40px;padding-bottom:64px}
/* 입장 배지 — 라임 채움을 없앤 뒤(2026-10-01 색 통일) 어두운 띠 위에서 검은 테두리는 안 보여 옅은 크림 테두리로 */
.hero-kicker{margin-bottom:12px;border:1px solid var(--color-on-dark-mute)}
.hero-side{gap:0}
.hero-side .lede{font-size:17px;max-width:560px}
.hero-notice{align-self:end}
.notice-sum{margin:0;font:400 14px/1.55 var(--font-sans)}
.notice-more{margin-top:var(--spacing-xs)}
/* 요약 줄 — 흰 밑줄로 누를 수 있는 곳임을 표시(열고 닫은 뒤에도 찾기 쉽게) */
.notice-more summary{padding:4px 0;cursor:pointer;font:500 13px/1.4 var(--font-sans);text-decoration:underline;text-decoration-color:var(--color-on-dark);text-decoration-thickness:1px;text-underline-offset:4px}
.notice-more summary:hover{text-decoration-thickness:2px}
.notice-more .kv{margin-top:var(--spacing-sm)}
/* 열림 표시 화살표(2026-10-01) — 기본 ▶ 는 움직일 수 없어 직접 그린다. 열면 90° 돌고, 닫기 시작하면 바로 돌아온다(data-closing) */
.hero-notice details > summary{list-style:none}
.hero-notice details > summary::-webkit-details-marker{display:none}
.hero-notice details > summary::before{content:"";display:inline-block;width:0;height:0;margin-right:8px;border-style:solid;border-width:4px 0 4px 6px;border-color:transparent transparent transparent currentColor;vertical-align:1px;transition:transform .25s cubic-bezier(.22,1,.36,1)}
.hero-notice details[open]:not([data-closing]) > summary::before{transform:rotate(90deg)}
@media (prefers-reduced-motion:reduce){.hero-notice details > summary::before{transition:none}}
.notice-more details{margin-top:var(--spacing-sm)}
.composer.one{grid-template-columns:minmax(0,1fr)}
.composer.one .composer-main{gap:var(--spacing-md)}
.composer-head{align-items:center}
.src-tabs{display:inline-flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:var(--rounded-md);background:var(--color-surface-soft)}
.src-tab{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 16px;border:0;border-radius:var(--rounded-sm);background:transparent;color:var(--color-charcoal);font:500 14px/1.2 var(--font-sans);cursor:pointer;transition:background-color .15s ease-out,color .15s ease-out}
.src-tab svg{width:16px;height:16px;flex:none}
.lbl-short{display:none}
.src-tab:hover{color:var(--color-ink)}
.src-tab[aria-selected="true"]{background:var(--color-canvas);color:var(--color-ink);box-shadow:0 0 0 1px var(--color-hairline-strong)}
.src-tab:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
.file-panel{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--spacing-lg)}
.file-panel.has-file{grid-template-columns:minmax(0,1fr) minmax(260px,340px);align-items:start}
.fc-checks{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.fc-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px 3px 8px;border-radius:var(--rounded-full);background:var(--color-canvas);border:1px solid var(--color-hairline);font:500 12px/1.4 var(--font-sans);color:var(--color-charcoal);animation:fc-in .32s cubic-bezier(.22,1,.36,1) both}
.fc-chip svg{width:12px;height:12px;color:var(--color-success)}
@media (prefers-reduced-motion:reduce){.fc-chip{animation:none}}
.file-checks h3{margin:0 0 var(--spacing-xs);font:500 12px/1.33 var(--font-sans);letter-spacing:.04em;color:var(--color-body)}
.file-checks .checks li{padding:8px 0;font-size:13px}
.file-checks .checks li > .ok,.file-checks .checks li > .muted{flex:none;white-space:nowrap}
.ms-line{padding:var(--spacing-sm) var(--spacing-md);border-radius:var(--rounded-md);background:var(--color-surface-soft)}
.ms-line:has([data-cold]){padding:0;background:transparent}
.ms-line :deep(.status-inline){display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
@media (max-width:850px){
  .file-panel.has-file{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:560px){
  .hero{padding-top:32px;padding-bottom:48px}
  .hero-side .lede{font-size:16px}
  .src-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%}
  .src-tab{padding:6px 8px;font-size:13px;text-align:center}
  .src-tab svg{display:none}
  .lbl-long{display:none}
  .lbl-short{display:inline;white-space:nowrap}
  /* 첫 화면 안에 '분석 시작'이 들어오게 — 단계 흐름 줄은 숨기고(결과까지 가는 길은 진행 화면에서 보인다), 쉬는 중 한 줄은 시작 버튼 아래로 */
  .dropzone{min-height:120px;padding:var(--spacing-lg)}
  .flow-line{display:none}
  .composer.one .composer-main > .ms-line{order:1}
  .composer.one .composer-main > :deep(.sfm){order:2}
}
/* 고른 파일 카드(2026-10-01) — 고르기 전 점선 상자 → 고른 뒤 실선 카드(가로: 아이콘 | 이름 · 정보 · 상태). 상태 = 테두리 색 + 점 + 글자 */
.dropzone.has-file{flex-direction:row;align-items:center;justify-content:flex-start;gap:var(--spacing-lg);padding:var(--spacing-lg) 56px var(--spacing-lg) var(--spacing-xl);text-align:left;border-style:solid;border-color:var(--color-hairline-strong);background:var(--color-paper)}
.dropzone.has-file.fc-ready{border-color:var(--color-success)}
.dropzone.has-file.fc-fail{border-color:var(--color-danger)}
.fc-doc{position:relative;flex:none;width:56px;height:64px;color:var(--color-ink);animation:fc-in .36s cubic-bezier(.22,1,.36,1)}
.dropzone .fc-doc svg{width:56px;height:64px;color:var(--color-ink)}
.fc-kind{position:absolute;left:-6px;bottom:6px;padding:3px 6px;border-radius:6px;background:var(--color-ink);color:var(--color-on-primary);font:700 10px/1 var(--font-mono);letter-spacing:.04em}
.fc-ready .fc-kind{background:var(--color-success)}
.fc-fail .fc-kind{background:var(--color-danger)}
.fc-body{display:grid;gap:4px;min-width:0}
.dropzone .fc-body .file-name{font:700 17px/1.35 var(--font-sans);letter-spacing:-.015em;color:var(--color-ink);overflow-wrap:anywhere}
.fc-meta{font:400 13px/1.4 var(--font-sans);color:var(--color-charcoal);font-variant-numeric:tabular-nums}
.fc-status{display:inline-flex;align-items:center;gap:6px;font:600 13px/1.4 var(--font-sans);color:var(--color-charcoal)}
.fc-status i{width:8px;height:8px;border-radius:50%;background:currentColor}
.fc-status[data-state="ready"]{color:var(--color-success)}
.fc-status[data-state="fail"]{color:var(--color-danger)}
.fc-status[data-state="checking"] i{background:transparent;border:2px solid currentColor;border-right-color:transparent;width:10px;height:10px;animation:fc-spin .8s linear infinite}
.fc-hint{font:400 12px/1.4 var(--font-sans);color:var(--color-body)}
@keyframes fc-in{from{opacity:0;transform:translateY(6px) scale(.92)}to{opacity:1;transform:none}}
@keyframes fc-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.fc-doc,.fc-status[data-state="checking"] i{animation:none}}
@media (max-width:560px){.dropzone.has-file{padding:var(--spacing-md) 48px var(--spacing-md) var(--spacing-md);gap:var(--spacing-md)}.fc-doc,.dropzone .fc-doc svg{width:44px;height:52px}.dropzone .fc-body .file-name{font-size:15px}}
/* 선택한 파일 지우기 X — 파일 놓는 곳 오른쪽 위 구석(가운데 정렬된 아이콘·파일 이름과 겹치지 않음), 누르는 영역 32px */
.dropzone-wrap{position:relative}
.dropzone-clear{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--color-hairline);border-radius:var(--rounded-full);background:var(--color-canvas);color:var(--color-charcoal);cursor:pointer;transition:background-color .15s ease-out,color .15s ease-out,border-color .15s ease-out}
.dropzone-clear svg{width:16px;height:16px}
.dropzone-clear:hover{background:var(--color-surface-soft);border-color:var(--color-hairline-strong);color:var(--color-ink)}
</style>
