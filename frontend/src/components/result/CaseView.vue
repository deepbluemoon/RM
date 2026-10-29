<script setup lang="ts">
// T095 유사 사례 — 사실관계 요약·공정위 판단·판단 근거 3구분(FR-028). 칩으로 D1 출처 드로어 연결.
// 사건 식별번호는 보이지 않는다 — 사건 이름만, 이름이 없으면 '공정위 사례'(2026-09-30)
import C6EvidenceChip from '@/components/common/C6EvidenceChip.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import type { Evidence, FtcCase } from '@/api/types'
import { caseTitle, ymd } from '@/lib/format'

withDefaults(defineProps<{ cases: FtcCase[] | null; loading?: boolean }>(), { loading: false })
const emit = defineEmits<{ openEvidence: [ev: Evidence, el: HTMLElement] }>()
</script>

<template>
  <div data-part="cases">
    <C7AreaPlaceholder v-if="loading && !cases" kind="processing" text="비슷한 사례를 찾고 있어요" />
    <C7AreaPlaceholder v-else-if="cases && !cases.length" kind="na" text="비슷한 사례가 없어요" />
    <div v-else-if="cases" class="stack">
      <article v-for="c in cases" :key="c.evidenceVersionId" class="card" :data-case="c.evidenceVersionId">
        <div class="row between mb-md">
          <h4 class="t-body-sm-strong">{{ caseTitle(c.sourceName) }}<span v-if="c.publishedDate" class="muted"> · 공개 {{ ymd(c.publishedDate) }}</span></h4>
          <C6EvidenceChip :evidence="c" @open="(ev, el) => emit('openEvidence', ev, el)" />
        </div>
        <div class="case3">
          <div><div class="t-caption-sm muted">무슨 일이 있었나</div><p class="t-body-sm m-0 mt-xs">{{ c.caseFacts ?? '제공 불가' }}</p></div>
          <div><div class="t-caption-sm muted">공정위 판단</div><p class="t-body-sm m-0 mt-xs">{{ c.caseJudgment ?? '제공 불가' }}</p></div>
          <div><div class="t-caption-sm muted">판단한 이유</div><p class="t-body-sm m-0 mt-xs">{{ c.caseBasis ?? '제공 불가' }}</p></div>
        </div>
      </article>
    </div>
  </div>
</template>
