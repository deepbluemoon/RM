<script setup lang="ts">
// C9 근거 변경 안내 띠 — 어두운 반전을 쓰지 않는다(반전 1회 규칙). 기록에 보관된 결과에 나타난다.
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    impact: { amend?: number; repeal?: number; newCase?: number; stdTermsRevision?: number } | null | undefined
    variant?: 's4' | 's6' | 's8'
  }>(),
  { variant: 's4' },
)
const emit = defineEmits<{ view: []; reanalyze: [] }>()
const total = computed(() => {
  const i = props.impact
  return i ? (i.amend ?? 0) + (i.repeal ?? 0) + (i.newCase ?? 0) + (i.stdTermsRevision ?? 0) : 0
})
</script>

<template>
  <div v-if="impact && total > 0" class="change-band" role="note" data-c="C9">
    <p>
      <strong>{{ variant === 's8' ? '이후 근거 자료가 바뀜' : '분석한 뒤에 근거 자료가 바뀌었어요' }}</strong>
      · 법 개정 {{ impact.amend ?? 0 }} · 법 폐지 {{ impact.repeal ?? 0 }} · 새 사례 {{ impact.newCase ?? 0 }} · 표준약관 개정 {{ impact.stdTermsRevision ?? 0 }}
    </p>
    <div v-if="variant !== 's8'" class="row">
      <button type="button" class="btn btn-secondary" data-action="view" @click="emit('view')">바뀐 내용 보기</button>
      <button type="button" class="btn btn-secondary" data-action="reanalyze" @click="emit('reanalyze')">다시 분석</button>
    </div>
  </div>
</template>
