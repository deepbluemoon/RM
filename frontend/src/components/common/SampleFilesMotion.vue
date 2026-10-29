<script setup lang="ts">
// 예시 약관 파일 모션(2026-09-30) — 흐름 줄 아래에서 예시 파일(모람 약관)이 옆으로 흐르고,
// 몇 초마다 반투명 복제본 하나가 위쪽 파일 놓는 곳으로 떠올라 사라진다.
// 끌어다 놓기(2026-09-30): 카드를 파일 놓는 곳에 끌어다 놓으면 예시 파일을 숨은 파일 입력칸에 채우고 change 를 보낸다
//   → S1Intake 의 onFile → handleFile(사용자가 고른 파일과 같은 경로). S1Intake 코드는 바꾸지 않는다(다른 세션 소유).
//   의존 표식: data-part="dropzone" · data-part="file-input" · /samples/<예시 파일> — 바뀌면 테스트가 실패한다.
// 예시 3종(2026-10-01): HWPX(짧은 6개 조) · PDF(100개 조) · HWP(120개 조). 원천 = frontend/samples-src/*.txt,
//   파일은 `npm run samples:build --prefix backend` 가 만들고 서버의 실제 경로(사전 검사 · 추출 · 조 나누기 · 계약서 판별)로 검사한다.
//   카드마다 자기 파일 — 끌어다 놓으면 끈 카드의 파일, 누르면 누른 카드의 파일. 키보드 · 휴대폰은 아래 줄의 파일별 버튼.
// 누르기(2026-09-30 S1 줄이기 — 예시 문서 칸을 없앰): 카드를 눌러도 같은 경로로 넣는다. 카드에 포인터를 올리면 흐름이 멈춰 누르기 쉽다.
//   끌거나 움직이는 대상을 누르지 않는 대안 = 아래 줄의 '예시 약관 넣기' 버튼(키보드 · 휴대폰, WCAG 2.5.7).
// 오해 방지: 모든 파일에 '예시' 표시, 떠오르는 애니메이션은 파일 놓는 곳의 상태·문구를 바꾸지 않는다.
// 접근성: 장식이라 aria-hidden, 5초 넘게 움직이므로 멈춤 버튼(WCAG 2.2.2), 모션 줄이기 · 화면 밖 · 탭 숨김이면 멈춘다.
// 휴대폰(≤850)에서는 흐르는 카드와 안내 글을 숨기고 '예시 약관 넣기' 버튼만 남긴다.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ active: boolean; target?: string; intervalMs?: number }>(), {
  target: '.dropzone',
  intervalMs: 6000,
})

type Kind = 'hwpx' | 'pdf' | 'hwp'
interface SampleFile { id: string; url: string; file: string; mime: string; name: string; kind: Kind; size: string }
// 파일 이름에 '(예시)'를 붙여 분석 기록에도 예시로 남는다. 순서 = 짧은 것부터(처음 써 보는 사람이 빨리 결과를 본다)
const SAMPLES: SampleFile[] = [
  { id: 'moram-short', url: '/samples/moram-content-terms.hwpx', file: '모람 콘텐츠 이용약관(예시).hwpx', mime: 'application/haansofthwpx', name: '모람 콘텐츠 이용약관', kind: 'hwpx', size: '6개 조' },
  { id: 'moram-service', url: '/samples/moram-content-service-terms.pdf', file: '모람 콘텐츠 서비스 이용약관(예시).pdf', mime: 'application/pdf', name: '모람 콘텐츠 서비스 이용약관', kind: 'pdf', size: '100개 조' },
  { id: 'semo-learning', url: '/samples/semo-online-learning-terms.hwp', file: '세모 온라인 학습 서비스 이용약관(예시).hwp', mime: 'application/x-hwp', name: '세모 온라인 학습 서비스 이용약관', kind: 'hwp', size: '120개 조' },
]
const DRAG_MARK = 'application/x-crd-sample'
const loop = [...SAMPLES, ...SAMPLES] // 두 벌을 이어 붙여 끊김 없이 반복

const root = ref<HTMLElement | null>(null)
const ghost = ref<SampleFile | null>(null)
const ghostEl = ref<HTMLElement | null>(null)
const userPaused = ref(false)
const reduced = ref(false)
const visible = ref(true)
const pageShown = ref(true)
const dragging = ref(false)
const inserting = ref(false)
const insertFailed = ref(false)

const running = computed(() => props.active && !userPaused.value && !reduced.value && visible.value && pageShown.value && !dragging.value)

let timer: ReturnType<typeof setTimeout> | null = null
let io: IntersectionObserver | null = null
let mq: MediaQueryList | null = null
let anim: Animation | null = null
let watched: Element | null = null

// 감시 대상을 지금 요소 하나로 맞춘다 — 같은 요소면 그대로, 바뀌었으면 옛 요소를 풀고 새 요소를 감시
function track(el: Element | null) {
  if (!io || el === watched) return
  if (watched) io.unobserve(watched)
  watched = el
  if (el) { visible.value = true; io.observe(el) }
}

function onMq() { reduced.value = !!mq?.matches }
function onVis() { pageShown.value = !document.hidden }

function schedule() {
  if (timer) clearTimeout(timer)
  timer = null
  if (running.value) timer = setTimeout(fly, props.intervalMs)
}

// 트랙 가운데에 가장 가까운 파일을 골라 그 자리에서 파일 놓는 곳 가운데로 곡선 비행
function fly() {
  timer = null
  const el = root.value
  if (!running.value || !el || !el.offsetParent) return schedule()
  const drop = el.closest('.composer-main')?.querySelector<HTMLElement>(props.target) ?? document.querySelector<HTMLElement>(props.target)
  const cards = [...el.querySelectorAll<HTMLElement>('.sfm-card')]
  if (!drop || !cards.length) return schedule()
  const box = el.getBoundingClientRect()
  const mid = box.left + box.width / 2
  const pick = cards.reduce((a, b) => (Math.abs(b.getBoundingClientRect().left + b.offsetWidth / 2 - mid) < Math.abs(a.getBoundingClientRect().left + a.offsetWidth / 2 - mid) ? b : a))
  const i = Number(pick.dataset.i ?? 0)
  const from = pick.getBoundingClientRect()
  const to = drop.getBoundingClientRect()
  ghost.value = loop[i]
  void nextTick(() => {
    const g = ghostEl.value
    if (!g || typeof g.animate !== 'function') { ghost.value = null; return schedule() }
    const x0 = from.left - box.left, y0 = from.top - box.top
    const dx = to.left + to.width / 2 - (from.left + from.width / 2)
    const dy = to.top + to.height / 2 - (from.top + from.height / 2)
    g.style.left = `${x0}px`
    g.style.top = `${y0}px`
    anim = g.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 0 },
        { transform: `translate(${dx * 0.1}px, ${-18}px) scale(1.02)`, opacity: 0.85, offset: 0.18 },
        { transform: `translate(${dx * 0.55}px, ${dy * 0.62}px) scale(0.95)`, opacity: 0.8, offset: 0.62 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.82)`, opacity: 0 },
      ],
      { duration: 1700, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
    )
    anim.onfinish = () => { ghost.value = null; anim = null; schedule() }
  })
}

function stopFlight() {
  if (timer) clearTimeout(timer)
  timer = null
  anim?.cancel()
  anim = null
  ghost.value = null
}

watch(running, (r) => (r ? schedule() : stopFlight()))

// ---- 끌어다 놓기
function onDragStart(e: DragEvent, f: SampleFile) {
  if (!e.dataTransfer) return
  e.dataTransfer.setData(DRAG_MARK, f.id)
  e.dataTransfer.setData('text/plain', f.file)
  e.dataTransfer.effectAllowed = 'copy'
  dragging.value = true
  insertFailed.value = false
}
function onDragEnd() { dragging.value = false }

// 문서 전체에서 캡처 단계로 받는다 — 표식이 있는 예시 드래그가 파일 놓는 곳에 떨어졌을 때만 반응(그 밖의 드롭은 S1 이 그대로 처리)
function onDocDrop(e: DragEvent) {
  if (!props.active || !e.dataTransfer || ![...e.dataTransfer.types].includes(DRAG_MARK)) return
  const zone = (e.target as Element | null)?.closest?.('[data-part="dropzone"]')
  // 자기 작업판의 파일 놓는 곳일 때만 — 떨어져 나간(화면에 없는) 인스턴스나 다른 작업판은 반응하지 않는다
  const mine = root.value?.isConnected ? root.value.closest('.composer-main') : null
  if (!zone || !mine || zone.closest('.composer-main') !== mine) return
  dragging.value = false
  const f = SAMPLES.find((x) => x.id === e.dataTransfer!.getData?.(DRAG_MARK)) ?? SAMPLES[0] // 표식 값 = 끈 카드의 예시 id
  void insertSample(f)
}

// 카드 · 버튼 누르기 — 끌어다 놓기와 같은 경로
function onCardClick(f: SampleFile) {
  if (!dragging.value) void insertSample(f)
}

const insertingId = ref<string | null>(null)
async function insertSample(f: SampleFile) {
  if (inserting.value) return
  inserting.value = true
  insertingId.value = f.id
  insertFailed.value = false
  try {
    const input = root.value?.closest('.composer-main')?.querySelector<HTMLInputElement>('[data-part="file-input"]') ?? document.querySelector<HTMLInputElement>('[data-part="file-input"]')
    if (!input || typeof DataTransfer !== 'function') throw new Error('no input')
    const res = await fetch(f.url)
    if (!res.ok) throw new Error(String(res.status))
    const dt = new DataTransfer()
    dt.items.add(new File([await res.blob()], f.file, { type: f.mime }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  } catch {
    insertFailed.value = true
  } finally {
    inserting.value = false
    insertingId.value = null
  }
}

onMounted(() => {
  if (typeof window.matchMedia === 'function') {
    mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    onMq()
    mq.addEventListener?.('change', onMq)
  }
  document.addEventListener('visibilitychange', onVis)
  document.addEventListener('drop', onDocDrop, true)
  if (typeof IntersectionObserver === 'function') {
    // 지금 붙어 있는 요소의 신호만 반영한다 — v-if 로 사라진 옛 요소의 '안 보임' 신호가 늦게 와도 무시
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === root.value) visible.value = e.isIntersecting
    }, { threshold: 0.2 })
    track(root.value)
  }
  schedule()
})
// active 가 꺼졌다 켜지면(v-if) 요소가 새로 만들어진다 — 옛 요소 감시를 풀고 새 요소를 다시 감시(결함 1: 탭 왕복 뒤 멈춘 채 굳음)
watch(root, (el) => track(el), { flush: 'post' })
onUnmounted(() => {
  stopFlight()
  io?.disconnect()
  mq?.removeEventListener?.('change', onMq)
  document.removeEventListener('visibilitychange', onVis)
  document.removeEventListener('drop', onDocDrop, true)
})
</script>

<template>
  <div v-if="active" ref="root" :class="['sfm', { paused: !running, still: reduced, dragging }]" data-part="sample-motion">
    <!-- 눈에 띄게(2026-10-01) — 제목 줄 + 옅은 띠 위에 큰 카드. 안내 문장은 제목 옆(마우스 동작 안내라 화면 읽기에서는 숨김) -->
    <div class="sfm-head">
      <p class="sfm-title"><span class="sfm-spark" aria-hidden="true">✦</span>파일이 없다면 예시 약관으로 먼저 해 보세요</p>
      <p class="sfm-hint" aria-hidden="true" data-part="sample-hint">예시 파일을 누르거나 위쪽 파일 놓는 곳으로 끌어다 놓아 보세요</p>
    </div>
    <div class="sfm-track" aria-hidden="true">
      <ul class="sfm-row">
        <li v-for="(f, i) in loop" :key="i" class="sfm-card" :data-i="i" :data-sample="f.id" draggable="true" @dragstart="onDragStart($event, f)" @dragend="onDragEnd" @click="onCardClick(f)">
          <span class="sfm-doc" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /><path d="M10 13h6M10 17h4" /></svg></span>
          <span :class="['sfm-kind', f.kind]">{{ f.kind.toUpperCase() }}</span>
          <span class="sfm-name">{{ f.name }}</span>
          <span class="sfm-size">{{ f.size }}</span>
          <span class="sfm-tag">예시</span>
        </li>
      </ul>
    </div>
    <div v-if="ghost" ref="ghostEl" class="sfm-card sfm-ghost" aria-hidden="true" data-part="sample-ghost">
      <span :class="['sfm-kind', ghost.kind]">{{ ghost.kind.toUpperCase() }}</span>
      <span class="sfm-name">{{ ghost.name }}</span>
      <span class="sfm-tag">예시</span>
    </div>
    <div class="sfm-foot">
    <!-- 파일별 넣기 버튼 — 끌기 · 움직이는 카드 누르기의 대안(키보드 · 휴대폰, WCAG 2.5.7) -->
    <div class="sfm-uses" role="group" aria-label="예시 약관 넣기">
      <button
        v-for="f in SAMPLES"
        :key="f.id"
        type="button"
        class="sfm-use"
        :aria-busy="insertingId === f.id ? 'true' : undefined"
        :disabled="inserting"
        data-action="sample-use"
        :data-sample="f.id"
        @click="onCardClick(f)"
      ><span class="sfm-use-kind">{{ f.kind.toUpperCase() }}</span>{{ insertingId === f.id ? '넣는 중…' : f.name }}</button>
    </div>
    <button
      v-if="!reduced"
      type="button"
      class="sfm-toggle"
      :aria-pressed="userPaused ? 'true' : 'false'"
      data-action="sample-motion-toggle"
      @click="userPaused = !userPaused"
    >
      {{ userPaused ? '예시 움직임 다시 보기' : '예시 움직임 멈춤' }}
    </button>
    </div>
    <p v-if="insertFailed" class="sfm-err" role="alert" data-part="sample-drop-failed">예시 파일을 넣지 못했어요. 잠시 뒤 다시 눌러 주세요.</p>
  </div>
</template>

<style scoped>
/* 눈에 띄게(2026-10-01) — 옅은 띠 · 큰 카드(52px) · 진한 이름 · 검은 형식 표시 · 노란 '예시' 표시, 넣기 버튼은 알약. 색은 테마 토큰만 */
.sfm { position: relative; display: flex; flex-direction: column; gap: var(--spacing-sm); margin-top: var(--spacing-sm); padding: var(--spacing-lg); border-radius: var(--rounded-lg); background: var(--color-paper); border: 1px solid var(--color-hairline); }
.sfm-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px var(--spacing-md); }
.sfm-title { margin: 0; display: inline-flex; align-items: center; gap: 6px; color: var(--color-ink); font: 600 15px/1.4 var(--font-sans); letter-spacing: -.01em; }
.sfm-spark { color: var(--color-risk-mid-line); font-size: 14px; }
.sfm-track { overflow: hidden; padding: 8px 0 10px; -webkit-mask-image: linear-gradient(to right, transparent, #000 24px, #000 calc(100% - 64px), transparent); mask-image: linear-gradient(to right, transparent, #000 24px, #000 calc(100% - 64px), transparent); } /* 양 끝 카드가 뚝 잘리지 않고 흐려지게 */
.sfm-row { display: flex; gap: 20px; width: max-content; margin: 0; padding: 0; list-style: none; animation: sfm-slide 40s linear infinite; }
.sfm.paused .sfm-row, .sfm-track:hover .sfm-row { animation-play-state: paused; }
.sfm.still .sfm-row { animation: none; }
@keyframes sfm-slide { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.sfm-card { display: inline-flex; align-items: center; gap: 10px; height: 52px; padding: 0 14px 0 10px; border: 1px solid var(--color-hairline-strong); border-radius: var(--rounded-md); background: var(--color-canvas); color: var(--color-ink); white-space: nowrap; font: 400 14px/1 var(--font-sans); user-select: none; transition: transform .18s ease-out, border-color .18s ease-out; }
.sfm-track .sfm-card { cursor: grab; }
.sfm-track .sfm-card:hover { border-color: var(--color-ink); transform: translateY(-2px); }
.sfm.dragging .sfm-track .sfm-card { cursor: grabbing; }
.sfm-doc { display: inline-flex; width: 22px; height: 22px; color: var(--color-ink); }
.sfm-doc svg { width: 100%; height: 100%; }
.sfm-kind { display: inline-flex; align-items: center; justify-content: center; min-width: 40px; height: 22px; padding: 0 6px; border-radius: 6px; background: var(--color-ink); color: var(--color-on-primary); font: 600 10px/1 var(--font-mono); letter-spacing: .04em; }
.sfm-name { font-weight: 600; letter-spacing: -.01em; }
.sfm-size { color: var(--color-body); font: 400 12px/1 var(--font-sans); }
.sfm-tag { padding: 3px 8px; border-radius: var(--rounded-full); background: var(--color-risk-mid); color: var(--color-risk-mid-ink); font: 600 11px/1.2 var(--font-sans); }
.sfm-ghost { position: absolute; z-index: 5; pointer-events: none; opacity: 0; will-change: transform, opacity; border-color: var(--color-ink); }
.sfm-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.sfm-hint { margin: 0; color: var(--color-body); font: 400 13px/1.4 var(--font-sans); }
.sfm-err { margin: 0; color: var(--color-danger); font: 400 13px/1.4 var(--font-sans); }
.sfm-toggle { flex: none; padding: 6px 2px; border: 0; background: transparent; color: var(--color-body); font: 400 13px/1.4 var(--font-sans); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.sfm-toggle:hover { color: var(--color-ink); }
.sfm-uses { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.sfm-use-kind { display: inline-flex; align-items: center; height: 18px; padding: 0 5px; border-radius: 4px; background: var(--color-ink); color: var(--color-on-primary); font: 600 10px/1 var(--font-mono); letter-spacing: .03em; }
.sfm-use:hover .sfm-use-kind { background: var(--color-on-primary); color: var(--color-ink); }
.sfm-use { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px 0 8px; border: 1px solid var(--color-ink); border-radius: var(--rounded-full); background: var(--color-canvas); color: var(--color-ink); font: 600 14px/1 var(--font-sans); cursor: pointer; transition: background-color .15s ease-out, color .15s ease-out; }
.sfm-use:hover { background: var(--color-ink); color: var(--color-on-primary); }
.sfm-use:disabled { border-color: var(--color-hairline-strong); color: var(--color-body); background: var(--color-canvas); cursor: default; }
@media (max-width: 850px) { .sfm { padding: var(--spacing-md); } .sfm-track, .sfm-hint, .sfm-toggle, .sfm-ghost { display: none; } .sfm-uses { flex-direction: column; width: 100%; } .sfm-use { width: 100%; justify-content: flex-start; height: 44px; } }
@media (prefers-reduced-motion: reduce) { .sfm-row { animation: none; } .sfm-card { transition: none; } }
</style>
