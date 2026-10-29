<script setup lang="ts">
// D1 출처 드로어 — 근거 6항목 + 사례 3구분. 열리면 제목으로 포커스, Esc 로 닫고 누른 칩으로 복귀,
// 드로어 안에서 Tab 포커스 순환(SD_02 §15-2).
import { nextTick, ref, watch, computed } from 'vue'
import { SOURCE_TYPE } from '@/lib/labels'
import { caseTitle, ymd } from '@/lib/format'
import type { Evidence } from '@/api/types'

const props = withDefaults(defineProps<{ open: boolean; evidence: Evidence | null; opener?: HTMLElement | null }>(), { opener: null })
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
const title = ref<HTMLElement | null>(null)
const dateLabel = computed(() => (props.evidence?.sourceType === 'law_article' ? '시행일' : '공개일'))
const dateValue = computed(() => ymd(props.evidence?.effectiveDate ?? props.evidence?.publishedDate ?? null))

watch(
  () => props.open,
  async (o, prev) => {
    if (o) {
      await nextTick()
      title.value?.focus()
    } else if (prev) {
      await nextTick()
      props.opener?.focus()
    }
  },
  { immediate: true },
)

function focusables(): HTMLElement[] {
  return Array.from(
    panel.value?.querySelectorAll<HTMLElement>('a[href],button,[tabindex]:not([tabindex="-1"]),input,select,textarea') ?? [],
  )
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key === 'Tab') {
    const f = focusables()
    if (!f.length) return
    const first = f[0]
    const last = f[f.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === title.value)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
}
</script>

<template>
  <Transition name="scrim-fade"><div v-if="open" class="scrim open" data-part="scrim" @click="emit('close')" /></Transition>
  <Transition name="drawer-slide">
  <aside
    v-if="open"
    ref="panel"
    class="drawer open"
    role="dialog"
    aria-modal="true"
    aria-labelledby="d1-title"
    data-c="D1"
    @keydown="onKey"
  >
    <header>
      <h4 id="d1-title" ref="title" tabindex="-1">출처</h4>
      <button type="button" class="btn btn-secondary" data-part="close" @click="emit('close')">닫기</button>
    </header>
    <div class="body">
      <slot name="before" />
      <dl v-if="evidence">
        <dt>출처 유형</dt>
        <dd>{{ SOURCE_TYPE[evidence.sourceType] ?? evidence.sourceType }}</dd>
        <template v-if="evidence.sourceType === 'ftc_case'">
          <dt>사건</dt>
          <dd>{{ caseTitle(evidence.sourceName) }}</dd>
        </template>
        <template v-else>
          <dt>출처명</dt>
          <dd>{{ evidence.sourceName }}</dd>
          <dt>조항 · 번호</dt>
          <dd>{{ evidence.identifier }}</dd>
        </template>
        <dt>원문 발췌</dt>
        <dd><blockquote>{{ evidence.excerpt }}</blockquote></dd>
        <template v-if="evidence.sourceType === 'ftc_case'">
          <dt>무슨 일이 있었나</dt>
          <dd>{{ evidence.caseFacts ?? '알 수 없어요' }}</dd>
          <dt>공정위 판단</dt>
          <dd>{{ evidence.caseJudgment ?? '알 수 없어요' }}</dd>
          <dt>판단한 이유</dt>
          <dd>{{ evidence.caseBasis ?? '알 수 없어요' }}</dd>
        </template>
        <dt>{{ dateLabel }}</dt>
        <dd>{{ dateValue || '알 수 없어요' }}</dd>
        <dt>출처 링크</dt>
        <dd>
          <a :href="evidence.sourceUrl" target="_blank" rel="noopener noreferrer">출처 원문 새 창으로 열기</a>
          <p class="t-caption-sm muted m-0 mt-xs">
            출처 페이지가 열리지 않으면 위 발췌를 봐 주세요. 발췌는 서비스에 저장해 둔 원문이에요.
          </p>
        </dd>
        <template v-if="evidence.changedSinceAnalysis">
          <dt>상태</dt>
          <dd>분석한 뒤에 바뀌었어요</dd>
        </template>
      </dl>
    </div>
  </aside>
  </Transition>
</template>
