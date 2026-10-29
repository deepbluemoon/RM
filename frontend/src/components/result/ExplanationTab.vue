<script setup lang="ts">
// T093 쉬운 설명(S4-C) / 검토 포인트(S4-B) — 주장에 초점을 두면 연결 근거 칩이 강조된다(4.9).
// G9 면 C7 "설명 제공 불가"(판정·근거는 계속 제공 — U5). 판정을 바꾸는 조작 없음(U6).
import { computed, ref } from 'vue'
import C6EvidenceChip from '@/components/common/C6EvidenceChip.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import type { Evidence, Explanation, Perspective } from '@/api/types'

const props = withDefaults(
  defineProps<{ explanation: Explanation | null; evidence: Evidence[]; perspective: Perspective; loading?: boolean }>(),
  { loading: false },
)
const emit = defineEmits<{ openEvidence: [ev: Evidence, el: HTMLElement] }>()
const litId = ref<number | null>(null)
// 키보드 초점(Tab)만 강조를 켠다 — 마우스 클릭은 focus → click 순으로 와서 click 의 토글이 방금 켠 강조를 끄게 된다
function onFocus(e: FocusEvent, id: number) {
  if ((e.target as HTMLElement).matches(':focus-visible')) litId.value = id
}
const business = computed(() => props.perspective === 'business')
const claims = computed(() => props.explanation?.claims ?? [])
const unavailable = computed(() => !!props.explanation && (!props.explanation.available || !!props.explanation.gate))

function evFor(id: number) {
  return props.evidence.find((e) => e.evidenceVersionId === id)
}
</script>

<template>
  <div data-part="explanation">
    <C7AreaPlaceholder v-if="loading && !explanation" kind="processing" text="설명을 만들고 있어요" />
    <C7AreaPlaceholder
      v-else-if="unavailable"
      kind="unavailable"
      :text="`${business ? '검토 포인트를' : '설명을'} 보여 드릴 수 없어요. 근거를 직접 확인해 주세요`"
    />
    <template v-else-if="explanation">
      <p class="t-body-sm charcoal m-0 mb-md">
        <template v-if="business">어떤 다툼이나 시정 조치(고치라는 명령)로 이어질 수 있는지, 무엇을 살펴보면 좋을지 정리했어요. 문장을 누르면 그 문장의 근거를 보여 드려요.</template>
        <template v-else>쉬운 말로 풀어 쓴 설명이에요. 문장을 누르면 그 문장의 근거를 보여 드려요.</template>
      </p>
      <ol class="claims" :aria-label="business ? '검토 포인트' : '쉬운 설명'">
        <li v-for="c in claims" :key="c.seq">
          <button
            type="button"
            :aria-pressed="litId === c.evidenceVersionId ? 'true' : 'false'"
            :data-claim="c.seq"
            @click="litId = litId === c.evidenceVersionId ? null : c.evidenceVersionId"
            @focus="onFocus($event, c.evidenceVersionId)"
          >
            <C8Masked :text="c.text" />
          </button>
        </li>
      </ol>
      <C7AreaPlaceholder v-if="!claims.length" kind="na" text="근거가 확인된 설명 문장이 없어요. 근거를 직접 확인해 주세요" />
      <div class="chips mt-lg" aria-label="근거">
        <span class="t-body-sm muted">근거:</span>
        <C6EvidenceChip
          v-for="e in evidence"
          :key="e.evidenceVersionId"
          :evidence="e"
          :lit="litId === e.evidenceVersionId"
          @open="(ev, el) => emit('openEvidence', ev, el)"
        />
      </div>
      <p v-if="litId != null && !evFor(litId)" class="t-caption-sm muted">이 문장의 근거는 아래 근거 목록에 없어요.</p>
    </template>
  </div>
</template>
