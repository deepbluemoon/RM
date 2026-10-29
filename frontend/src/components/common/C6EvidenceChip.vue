<script setup lang="ts">
// C6 근거 칩 — 누르면 D1 출처 드로어가 열린다(화면 전환 없음). 강조(lit)·변경됨(changed) 상태.
import { computed, ref } from 'vue'
import { SOURCE_TYPE } from '@/lib/labels'
import { caseTitle, evidenceName } from '@/lib/format'
import type { Evidence } from '@/api/types'

const props = withDefaults(defineProps<{ evidence: Evidence; lit?: boolean }>(), { lit: false })
const emit = defineEmits<{ open: [evidence: Evidence, el: HTMLElement] }>()
const el = ref<HTMLButtonElement | null>(null)
const typeText = computed(() => SOURCE_TYPE[props.evidence.sourceType] ?? props.evidence.sourceType)
// 공정위 사례는 식별번호 대신 사건 이름(없으면 '공정위 사례')
const isCase = computed(() => props.evidence.sourceType === 'ftc_case')
// 법령 · 표준약관은 '이름 + 조항 번호'(예: 전자상거래법 제17조) — 번호만 보이면 어느 법인지 몰랐다. 원문 옆 메모와 같은 표기(2026-10-01)
const shown = computed(() => (isCase.value ? caseTitle(props.evidence.sourceName) : evidenceName(props.evidence.sourceName, props.evidence.identifier)))
const label = computed(() => (isCase.value ? `${typeText.value} ${shown.value}` : `${typeText.value} ${props.evidence.sourceName} ${props.evidence.identifier}`))
</script>

<template>
  <button
    ref="el"
    type="button"
    :class="['chip', { lit, changed: evidence.changedSinceAnalysis }]"
    data-c="C6"
    :data-evidence="evidence.evidenceVersionId"
    :aria-label="`근거 ${label}${evidence.changedSinceAnalysis ? ', 변경됨' : ''} — 출처 보기`"
    :aria-pressed="lit ? 'true' : undefined"
    @click="emit('open', evidence, el!)"
  >
    <small>{{ typeText }}</small><span :class="{ 'chip-name': isCase }">{{ isCase && shown === typeText ? '' : shown }}</span>
  </button>
</template>
