<script setup lang="ts">
// C2 게이트 차단 블록 (SD_02 §3-2). 필수 3요소 = 사유·해제 주체·다음 행동. 닫기 버튼 없음(U1).
// 변형: (a) 사용자 해제형 (b) 타인 해제형 (c) 접근 차단형(full — 화면 본문 전체 대체)
// 제목 수준: 차단형(full)은 그 화면의 제목이므로 h1, 나머지는 h2(2026-09-30, WCAG 1.3.1)
import { computed, onMounted, ref, useId } from 'vue'
import { ACTOR_LABEL, type GateView } from '@/lib/gates'

const props = withDefaults(defineProps<{ gate: GateView; full?: boolean; autofocus?: boolean; busyAction?: string | null }>(), {
  full: false,
  autofocus: true,
  busyAction: null,
})
const emit = defineEmits<{ action: [id: string] }>()
const titleEl = ref<HTMLElement | null>(null)
const titleId = `gate-title-${useId()}`

const actorText = computed(() => {
  if (props.gate.releaseText) return props.gate.releaseText
  return ACTOR_LABEL[props.gate.releaseActor] ?? props.gate.releaseActor
})
const variant = computed(() => (props.full ? 'full' : props.gate.releaseActor === 'user' ? 'user' : 'other'))

onMounted(() => {
  // §15-2: 차단이 생기면 포커스를 C2 블록 제목으로 옮긴다
  if (props.autofocus) titleEl.value?.focus({ preventScroll: false })
})
defineExpose({ focus: () => titleEl.value?.focus() })
</script>

<template>
  <section
    :class="['gate', { full }]"
    role="alert"
    :aria-labelledby="titleId"
    data-c="C2"
    :data-gate="gate.gate"
    :data-variant="variant"
    data-gate-block
  >
    <div class="gate-head">
      <span class="gate-id">{{ gate.gate }}</span>
      <component :is="full ? 'h1' : 'h2'" :id="titleId" ref="titleEl" class="gate-title" tabindex="-1">{{ gate.title }}</component>
    </div>
    <dl>
      <dt>이유</dt>
      <dd data-part="reason">{{ gate.reason }}</dd>
      <dt>누가 풀 수 있나요</dt>
      <dd data-part="actor">{{ actorText }}</dd>
      <slot name="extra" />
    </dl>
    <slot />
    <div v-if="gate.nextActions.length" class="actions">
      <button
        v-for="a in gate.nextActions"
        :key="a.id"
        type="button"
        class="btn btn-secondary"
        :data-action="a.id"
        :aria-busy="busyAction === a.id ? 'true' : undefined"
        @click="emit('action', a.id)"
      >{{ busyAction === a.id ? '확인하고 있어요…' : a.label }}</button>
    </div>
  </section>
</template>
