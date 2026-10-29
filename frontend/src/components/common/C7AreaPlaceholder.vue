<script setup lang="ts">
// C7 영역 대체 문구 — 결측 3종(처리 중 / 제공 불가 / 해당 없음). 스켈레톤·회색 빈 칸 금지(U5).
const props = defineProps<{ kind: 'processing' | 'unavailable' | 'na'; text: string }>()
const KIND = { processing: '진행 중', unavailable: '지금은 볼 수 없어요', na: '해당 없어요' } as const
void props
</script>

<template>
  <div class="fallback" data-c="C7" :data-kind="kind">
    <span class="kind">{{ KIND[kind] }}</span>
    <p>{{ text }}</p>
    <slot />
  </div>
</template>
