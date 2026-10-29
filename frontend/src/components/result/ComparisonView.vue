<script setup lang="ts">
// T094 비교 보기 — 원문 ↔ 법령 조문 / 원문 ↔ 표준약관, 좌우 2단(≤768px 상하). 비교 대상이 없으면 C3 사유 + C7 해당 없음.
import { computed, ref, watch } from 'vue'
import C3ReasonButton from '@/components/common/C3ReasonButton.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import type { Comparison, Perspective } from '@/api/types'

const props = withDefaults(
  defineProps<{ comparison: Comparison | null; perspective: Perspective; clauseText?: string; loading?: boolean; evidenceUnconfirmed?: boolean }>(),
  { clauseText: '', loading: false, evidenceUnconfirmed: false },
)
const business = computed(() => props.perspective === 'business')
const mode = ref<'law' | 'std'>(business.value ? 'std' : 'law')
watch(
  () => props.comparison,
  (c) => {
    if (!c) return
    if (mode.value === 'law' && !c.law && c.stdTerms) mode.value = 'std'
    if (mode.value === 'std' && !c.stdTerms && c.law && !business.value) mode.value = 'law'
  },
  { immediate: true },
)
const lawReason = computed(() =>
  props.comparison && !props.comparison.law
    ? { text: props.evidenceUnconfirmed ? '근거를 확인하지 못한 조항이라 법 조문과는 비교하지 않아요' : '비교할 법 조문이 없어요' }
    : null,
)
const stdReason = computed(() => (props.comparison && !props.comparison.stdTerms ? { text: '표준약관에 비슷한 조항이 없어요' } : null))
const target = computed(() => (mode.value === 'law' ? props.comparison?.law ?? null : props.comparison?.stdTerms ?? null))
const original = computed(() => props.comparison?.clauseText ?? props.clauseText)
</script>

<template>
  <div data-part="comparison">
    <C7AreaPlaceholder v-if="loading && !comparison" kind="processing" text="비교할 조문을 찾고 있어요" />
    <template v-else-if="comparison">
      <div class="row mb-lg" role="group" aria-label="무엇과 비교할지 고르기">
        <C3ReasonButton label="계약서 원문 ↔ 법 조문" :reason="lawReason" :primary="false" data-mode="law" @click="mode = 'law'" />
        <C3ReasonButton label="계약서 원문 ↔ 표준약관" :reason="stdReason" :primary="false" data-mode="std" @click="mode = 'std'" />
      </div>
      <div class="compare" :data-mode="mode">
        <div>
          <div class="col-head">{{ business ? '우리 회사 약관 조항' : '계약서 원문' }}</div>
          <blockquote><C8Masked :text="original" /></blockquote>
        </div>
        <div>
          <div class="col-head">{{ mode === 'law' ? '법 조문' : '표준약관' }}<template v-if="target"> · {{ target.sourceName }} {{ target.identifier }}</template></div>
          <blockquote v-if="target">{{ target.excerpt }}</blockquote>
          <C7AreaPlaceholder v-else kind="na" :text="mode === 'law' ? '비교할 법 조문이 없어요' : '표준약관에 비슷한 조항이 없어요'" />
        </div>
      </div>
      <div class="mt-lg" v-if="business && comparison.businessDiffNotes?.length">
        <h4 class="t-body-sm-strong mb-xs">표준약관과 다른 점</h4>
        <ul class="bullets">
          <li v-for="(n, i) in comparison.businessDiffNotes" :key="i">{{ n }}</li>
        </ul>
      </div>
    </template>
  </div>
</template>
