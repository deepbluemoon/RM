<script setup lang="ts">
// C3 사유 붙은 비활성 버튼 (SD_02 §3-2, §15-2). disabled 대신 aria-disabled + aria-describedby.
// 비활성이면 눌러도 동작하지 않고, 같은 화면의 C2 블록으로 이동한다.
import { computed, useId } from 'vue'

export interface DisabledReason { gate?: string; text: string }

const props = withDefaults(
  defineProps<{ label: string; reason?: DisabledReason | null; primary?: boolean; busy?: boolean; busyLabel?: string; type?: 'button' | 'submit' }>(),
  { reason: null, primary: false, busy: false, busyLabel: '처리 중…', type: 'button' },
)
const emit = defineEmits<{ click: [ev: MouseEvent] }>()
const rid = `reason-${useId()}`
const disabled = computed(() => !!props.reason || props.busy)
// 사유에는 게이트 번호(G2 등)를 보이지 않는다 — 번호는 바로 위 C2 블록에 있고, 사용자에게는 내부 용어라서(2026-10-01)
const reasonText = computed(() => props.reason?.text ?? '')

function onClick(ev: MouseEvent) {
  if (disabled.value) {
    ev.preventDefault()
    if (props.reason?.gate) {
      const block = document.querySelector<HTMLElement>(`[data-gate-block][data-gate="${props.reason.gate}"]`) ??
        document.querySelector<HTMLElement>('[data-gate-block]')
      block?.scrollIntoView?.({ block: 'center' })
      block?.querySelector<HTMLElement>('.gate-title')?.focus()
    }
    return
  }
  emit('click', ev)
}
</script>

<template>
  <div class="reasoned" data-c="C3">
    <button
      :type="type"
      :class="['btn', primary && !disabled ? 'btn-primary' : 'btn-secondary']"
      :aria-disabled="disabled ? 'true' : undefined"
      :aria-busy="busy ? 'true' : undefined"
      :aria-describedby="reason ? rid : undefined"
      :title="reason ? reasonText : undefined"
      @click="onClick"
    >{{ busy ? busyLabel : label }}</button>
    <span v-if="reason" :id="rid" class="reason" data-part="reason">{{ reason.text }}</span>
  </div>
</template>
