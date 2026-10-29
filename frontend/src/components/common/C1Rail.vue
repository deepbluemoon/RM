<script setup lang="ts">
// C1 진행 레일 (SD_02 §2-3·§3-2). 단계 변화는 aria-live="polite" 로 읽힌다(§15-2).
import { nextTick, ref, useId } from 'vue'
import C8Masked from './C8Masked.vue'
import { smoothHeight } from '@/lib/smoothHeight' // 펼친 판 높이째 열고 닫기 — 아래 내용이 툭 밀리지 않게(2026-10-01)
export type RailState = 'wait' | 'now' | 'done' | 'block' | 'hold' | 'reuse'
/** info — 끝난 단계를 누르면 레일 아래에 펼쳐 보이는 내용(2026-10-01): 제목 · 요약 줄(숫자는 **굵게** 표기 가능) · 미리보기(파일 첫 몇 줄) */
export interface RailInfo { title: string; lines: string[]; preview?: string[]; previewLabel?: string }
export interface RailStep { label: string; state: RailState; gate?: string; info?: RailInfo }
export interface RailSub { label: string; state: 'waiting' | 'running' | 'done' | 'blocked' | 'reused' }


const props = withDefaults(
  defineProps<{ steps: RailStep[]; label?: string; detail?: RailSub[] | null; sticky?: boolean }>(),
  { label: '', detail: null, sticky: true },
)

const SUB_TEXT: Record<RailSub['state'], string> = {
  waiting: '기다리는 중', running: '진행 중', done: '완료', blocked: '멈춤', reused: '지난 결과 사용',
}

function text(s: RailStep, i: number): string {
  const n = `${i + 1}. ${s.label}`
  switch (s.state) {
    case 'done': return `${n} 완료`
    case 'block': return `${n} · 멈춤`
    case 'hold': return `${n} · 기다리는 중`
    case 'reuse': return `${n} · 지난 결과 사용`
    default: return n
  }
}
void props
// 끝난 단계 펼치기 — 한 번에 하나, 같은 단계를 다시 누르거나 Esc 면 닫고 초점은 그 단계 버튼으로
const openIdx = ref<number | null>(null)
const panelId = `rail-info-${useId()}`
const btns = ref<HTMLButtonElement[]>([])
// 열린 채로 다른 단계를 누르면(2026-10-01) 판을 닫았다 열지 않고 내용만 옆으로 미끄러뜨린다 — 오른쪽 단계면 오른쪽에서, 왼쪽 단계면 왼쪽에서 들어온다.
// 두 내용이 겹친 채(같은 칸) 엇갈려 움직이고, 판 높이는 옛 내용 높이 → 새 내용 높이로 함께 바뀐다(툭 줄거나 늘지 않게)
const dir = ref<'next' | 'prev'>('next')
const track = ref<HTMLElement | null>(null)
let fromH = 0
let clipTimer = 0
const SLIDE_MS = 340
const EASE = 'cubic-bezier(.22, 1, .36, 1)'
function toggle(i: number) {
  const cur = openIdx.value
  if (cur != null && cur !== i) {
    dir.value = i > cur ? 'next' : 'prev'
    fromH = track.value?.getBoundingClientRect().height ?? 0
  }
  openIdx.value = cur === i ? null : i
}
function slideHeight(el: Element) { // 인자 하나 = 끝은 CSS transition 이 정한다(done 을 받으면 Vue 가 done 만 기다린다)
  const t = track.value
  const h0 = fromH
  fromH = 0
  if (!t || !h0) return
  const toH = (el as HTMLElement).getBoundingClientRect().height
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced) return
  // 미끄러지는 동안만 판 밖으로 삐져나가지 않게 자른다(평소에 자르면 닫기 버튼 초점 테두리가 잘린다)
  t.style.overflow = 'hidden'
  window.clearTimeout(clipTimer)
  clipTimer = window.setTimeout(() => { if (track.value) track.value.style.overflow = '' }, SLIDE_MS + 40)
  if (typeof t.animate === 'function' && Math.abs(toH - h0) >= 1) t.animate([{ height: `${h0}px` }, { height: `${toH}px` }], { duration: SLIDE_MS, easing: EASE })
}
async function closeInfo() {
  const i = openIdx.value
  openIdx.value = null
  await nextTick()
  if (i != null) btns.value.find((b) => b.dataset.step === String(i))?.focus()
}
// **굵게** 표기 → <b> (화면이 만든 고정 문구 · 숫자 · 파일 이름 — HTML 이스케이프 후 바꾼다)
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const rich = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
</script>

<template>
  <div :class="['rail-wrap', { static: !sticky }]" data-c="C1">
    <div aria-live="polite" aria-atomic="false">
      <nav class="rail" aria-label="진행 단계">
        <span v-if="label" class="rid">{{ label }}</span>
        <template v-for="(s, i) in steps" :key="i">
          <span v-if="i > 0" class="sep" aria-hidden="true">›</span>
          <button
            v-if="s.info"
            ref="btns"
            type="button"
            :class="['step', 'has-info', s.state, { open: openIdx === i }]"
            :aria-expanded="openIdx === i ? 'true' : 'false'"
            :aria-controls="panelId"
            :data-state="s.state"
            :data-step="i"
            @click="toggle(i)"
            @keydown.esc.prevent="closeInfo"
          >{{ text(s, i) }}<span class="step-caret" aria-hidden="true">▾</span></button>
          <span
            v-else
            :class="['step', s.state]"
            :aria-current="s.state === 'now' || s.state === 'block' ? 'step' : undefined"
            :data-state="s.state"
          >{{ text(s, i) }}</span>
        </template>
      </nav>
      <Transition :css="false" v-bind="smoothHeight">
        <section v-if="openIdx != null && steps[openIdx]?.info" :id="panelId" class="rail-info" data-part="rail-info" :aria-label="steps[openIdx].info!.title" @keydown.esc.prevent="closeInfo">
          <div ref="track" class="rail-info-track">
            <Transition :name="`rail-slide-${dir}`" @enter="slideHeight">
              <div :key="openIdx" class="rail-info-pane">
                <div class="rail-info-head">
                  <h2 class="rail-info-title">{{ steps[openIdx].info!.title }}</h2>
                  <button type="button" class="rail-info-close" aria-label="닫기" @click="closeInfo">✕</button>
                </div>
                <ul class="rail-info-lines">
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <li v-for="(l, k) in steps[openIdx].info!.lines" :key="k" v-html="rich(l)" />
                </ul>
                <template v-if="steps[openIdx].info!.preview?.length">
                  <p class="rail-info-plabel">{{ steps[openIdx].info!.previewLabel ?? '파일 첫 부분' }}</p>
                  <blockquote class="rail-info-preview" data-part="rail-preview">
                    <p v-for="(l, k) in steps[openIdx].info!.preview" :key="k"><C8Masked :text="l" /></p>
                  </blockquote>
                </template>
              </div>
            </Transition>
          </div>
        </section>
      </Transition>
      <p v-if="detail && detail.length" class="rail-detail" data-part="detail">
        <span class="visually-hidden">세부 진행:</span>
        <span v-for="(d, i) in detail" :key="i" :class="['sub', d.state]">
          <b v-if="d.state === 'running'">{{ d.label }} {{ SUB_TEXT[d.state] }}</b>
          <template v-else>{{ d.label }} {{ SUB_TEXT[d.state] }}</template>
        </span>
      </p>
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* 끝난 단계 펼치기(2026-10-01) — 단계 버튼은 레일 모양 그대로 + ▾, 펼친 판은 레일 바로 아래에 옅게 떠오른다 */
.step.has-info { font: inherit; cursor: pointer; background: transparent; border: 1px solid var(--color-hairline-strong); }
.step.has-info:hover { border-color: var(--color-ink); background: var(--color-surface-soft); }
.step.has-info.open { border-color: var(--color-ink); background: var(--color-surface-soft); }
.step-caret { display: inline-block; margin-left: 2px; font-size: 13px; line-height: 1; color: var(--color-charcoal); transition: transform .2s ease-out; }
.step.has-info.open .step-caret { transform: rotate(180deg); }
.rail-info { margin-top: var(--spacing-md); padding: var(--spacing-lg); border: 1px solid var(--color-hairline); border-radius: var(--rounded-lg); background: var(--color-canvas); display: grid; gap: var(--spacing-sm); }
.rail-info-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.rail-info-title { margin: 0; font: 600 16px/1.4 var(--font-sans); color: var(--color-ink); }
.rail-info-close { width: 32px; height: 32px; border: 0; border-radius: var(--rounded-full); background: transparent; color: var(--color-body); cursor: pointer; }
.rail-info-close:hover { background: var(--color-surface-soft); color: var(--color-ink); }
.rail-info-lines { margin: 0; padding-left: 18px; display: grid; gap: 4px; font: 400 14px/1.55 var(--font-sans); color: var(--color-charcoal); }
.rail-info-lines :deep(b) { color: var(--color-ink); font-weight: 700; }
.rail-info-plabel { margin: var(--spacing-xs) 0 0; font: 600 12px/1.4 var(--font-sans); color: var(--color-body); }
.rail-info-preview { margin: 0; padding: var(--spacing-md) var(--spacing-lg); border-left: 3px solid var(--color-hairline-strong); border-radius: 0 var(--rounded-sm) var(--rounded-sm) 0; background: var(--color-paper); display: grid; gap: 6px; max-height: 180px; overflow: auto; }
.rail-info-preview p { margin: 0; font: 400 14px/1.6 var(--font-sans); color: var(--color-ink); }
/* 단계 바꿔 보기 — 옛 내용과 새 내용을 같은 칸에 겹쳐 엇갈려 미끄러뜨린다(transform · opacity 만) */
.rail-info-track { display: grid; }
.rail-info-pane { grid-area: 1 / 1; display: grid; gap: var(--spacing-sm); min-width: 0; }
.rail-slide-next-enter-active, .rail-slide-prev-enter-active { transition: transform .34s cubic-bezier(.22, 1, .36, 1), opacity .26s ease-out .04s; }
.rail-slide-next-leave-active, .rail-slide-prev-leave-active { transition: transform .34s cubic-bezier(.22, 1, .36, 1), opacity .18s ease-in; pointer-events: none; }
.rail-slide-next-enter-from, .rail-slide-prev-leave-to { transform: translateX(48px); opacity: 0; }
.rail-slide-next-leave-to, .rail-slide-prev-enter-from { transform: translateX(-48px); opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .step-caret { transition: none; }
  .rail-slide-next-enter-active, .rail-slide-prev-enter-active, .rail-slide-next-leave-active, .rail-slide-prev-leave-active { transition: none; }
}
</style>
