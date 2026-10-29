<script setup lang="ts">
// C4 기준일·비자문 고지 띠 (SD_02 §3-3). 닫을 수 없고, 관점은 표시만 한다(U7).
import { PERSPECTIVE } from '@/lib/labels'
import { ymd } from '@/lib/format'
import type { Perspective } from '@/api/types'

withDefaults(
  defineProps<{
    disclaimer?: string
    knowledgeDate?: string | null
    perspective?: Perspective | null
    variant?: 'default' | 'revisit' | 'reanalysis' | 'review'
  }>(),
  { disclaimer: '법률 자문이 아니에요. 결정하기 전에 근거를 직접 확인해 주세요', knowledgeDate: null, perspective: null, variant: 'default' },
)
</script>

<template>
  <div class="band" role="note" data-c="C4">
    <strong>{{ disclaimer }}</strong>
    <span v-if="knowledgeDate">
      <template v-if="variant === 'review'">당시 판단 기준 · </template>근거 자료 기준일 <strong>{{ ymd(knowledgeDate) }}</strong>
    </span>
    <span v-if="variant === 'revisit'">분석했던 당시의 기준일 그대로 보여 드려요</span>
    <span v-if="variant === 'reanalysis'">다시 분석한 결과예요 · 이전 결과도 함께 볼 수 있어요</span>
    <span v-if="perspective">보는 입장 <strong>{{ PERSPECTIVE[perspective] }}</strong></span>
    <slot />
  </div>
</template>
