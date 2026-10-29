<script setup lang="ts">
// S2·S3 C1 레일 아래 대기 안내 줄 — 경과 시간(mm:ss, 폴링 사이 로컬 틱) + 모델 적재·대기 안내.
// 토스트·스피너·스켈레톤 없이 문구로만 알린다(SD_02 §1-1). 부모 C1 의 aria-live 영역 안에 놓인다.
import { computed } from 'vue'
import { mmss, approxDuration } from '@/lib/format'
import type { ModelNotice } from '@/api/types'

const props = withDefaults(
  defineProps<{ elapsedSec: number | null; notice?: ModelNotice | null; expected?: string; stopped?: boolean }>(),
  { notice: null, expected: '보통 1~3분 걸려요. 분석 준비가 필요하면 조금 더 걸릴 수 있어요', stopped: false },
)

// 알려진 상황(준비 · 대기)은 화면 문구만 쓴다 — 서버 문구는 합니다체 · 내부 용어(모델 · 메모리)이고 같은 문장이 두 번 이어 붙어 나왔다(2026-09-30).
// 모델 이름(편법 탐지 모델 등)도 사용자 화면에는 붙이지 않는다. 모르는 kind 일 때만 서버 문구를 쓴다.
const STEP_BY_MODEL: Record<string, string> = { M1: '위험 조항 찾기를', M2: '위험 조항 찾기를', M3: '위험 판단을', M4: '계약 요약을' } // 조사까지
const noticeText = computed(() => {
  const n = props.notice
  if (!n) return ''
  const step = n.model ? STEP_BY_MODEL[n.model] : ''
  const est = n.estimatedSec != null ? ` 약 ${approxDuration(n.estimatedSec).replace(/^약\s*/, '')} 더 걸려요` : ''
  if (n.kind === 'cold_start' || n.kind === 'loading') return `${step || '분석을'} 준비하고 있어요.${est}`
  if (n.kind === 'queue') return '앞선 분석이 끝나기를 기다리고 있어요. 순서가 오면 바로 시작해요.'
  return n.message || ''
})
</script>

<template>
  <div class="rail-wait" data-part="wait-line">
    <span v-if="elapsedSec != null">지난 시간 <span class="clock" data-part="elapsed" aria-live="off" :aria-label="`지난 시간 ${mmss(elapsedSec)}`">{{ mmss(elapsedSec) }}</span></span>
    <template v-if="!stopped">
      <span v-if="noticeText" data-part="notice" :data-kind="notice?.kind"> · <b>{{ noticeText }}</b></span>
      <span class="muted" data-part="expected"> · {{ expected }}</span>
    </template>
  </div>
</template>
