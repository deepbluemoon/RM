<script setup lang="ts">
// 진행 막대(2026-10-01) — S2 · S3 공통. 큰 퍼센트 + 막대 + 한 줄 설명(숫자는 굵게 · 잉크 색으로 슬롯에서 강조).
// 막대는 role=progressbar(aria-valuenow). 바뀔 때마다 읽히지 않도록 aria-live 는 부모(C1)의 polite 영역에 맡기고 여기서는 걸지 않는다.
import { computed } from 'vue'

const props = withDefaults(defineProps<{ percent: number | null; label: string; done?: boolean; stopped?: boolean }>(), { done: false, stopped: false })
const pct = computed(() => (props.percent == null ? null : Math.max(0, Math.min(100, Math.round(props.percent)))))
</script>

<template>
  <div :class="['pm', { done, stopped }]" data-part="progress-meter">
    <div class="pm-top">
      <span class="pm-pct" data-part="progress-percent">{{ pct == null ? '—' : `${pct}%` }}</span>
      <span class="pm-text"><slot /></span>
    </div>
    <div
      class="pm-bar"
      role="progressbar"
      :aria-label="label"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="pct ?? undefined"
      :aria-valuetext="pct == null ? '준비 중' : `${pct}%`"
    >
      <span class="pm-fill" :style="{ transform: `scaleX(${(pct ?? 0) / 100})` }" />
    </div>
  </div>
</template>

<style scoped>
/* 막대는 transform(scaleX)만 움직인다 — 합성 단계에서 부드럽게, 다시 그리기 없음 */
.pm { display: grid; gap: 10px; }
.pm-top { display: flex; align-items: baseline; gap: var(--spacing-md); flex-wrap: wrap; }
.pm-pct { font: 700 32px/1 var(--font-display); letter-spacing: -.03em; color: var(--color-ink); font-variant-numeric: tabular-nums; min-width: 3ch; }
.pm-text { font: 400 15px/1.5 var(--font-sans); color: var(--color-charcoal); }
.pm-text :deep(b), .pm-text :deep(strong) { color: var(--color-ink); font-weight: 700; font-variant-numeric: tabular-nums; }
.pm-bar { position: relative; height: 8px; border-radius: var(--rounded-full); background: var(--color-surface-hover); overflow: hidden; }
.pm-fill { position: absolute; inset: 0; transform-origin: left center; background: var(--color-ink); border-radius: inherit; transition: transform .6s cubic-bezier(.22, 1, .36, 1); }
.pm.done .pm-fill { background: var(--color-success); }
.pm.stopped .pm-fill { background: var(--color-mute); }
@media (prefers-reduced-motion: reduce) { .pm-fill { transition: none; } }
</style>
