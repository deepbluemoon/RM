<script setup lang="ts">
// 확인 대화상자 — 그림자 없이 잉크 테두리 카드. 열리면 취소 버튼으로 포커스, Esc = 취소, 닫히면 이전 포커스로 복귀.
import { nextTick, ref, watch, useId } from 'vue'

const props = withDefaults(
  defineProps<{ open: boolean; title: string; message?: string; confirmLabel?: string; cancelLabel?: string; busy?: boolean }>(),
  { message: '', confirmLabel: '확인', cancelLabel: '취소', busy: false },
)
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const cancelBtn = ref<HTMLButtonElement | null>(null)
const box = ref<HTMLElement | null>(null)
let returnTo: HTMLElement | null = null
const tid = `dlg-${useId()}`

watch(
  () => props.open,
  async (o, prev) => {
    if (o) {
      returnTo = (document.activeElement as HTMLElement | null) ?? null
      await nextTick()
      cancelBtn.value?.focus()
    } else if (prev) {
      await nextTick()
      returnTo?.focus?.()
    }
  },
  { immediate: true },
)

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  } else if (e.key === 'Tab') {
    const f = Array.from(box.value?.querySelectorAll<HTMLElement>('button,a[href],input,textarea,select') ?? [])
    if (!f.length) return
    const i = f.indexOf(document.activeElement as HTMLElement)
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus() }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus() }
  }
}
</script>

<template>
  <Transition name="dialog-pop">
  <div v-if="open" class="dialog-scrim" @keydown="onKey">
    <div ref="box" class="dialog" role="alertdialog" aria-modal="true" :aria-labelledby="tid" :aria-describedby="`${tid}-d`">
      <h2 :id="tid">{{ title }}</h2>
      <div :id="`${tid}-d`">
        <p v-if="message">{{ message }}</p>
        <slot />
      </div>
      <div class="actions">
        <button ref="cancelBtn" type="button" class="btn btn-secondary" data-action="cancel" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button type="button" class="btn btn-primary" data-action="confirm" :aria-busy="busy ? 'true' : undefined" @click="!busy && emit('confirm')">
          {{ busy ? '처리 중…' : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
  </Transition>
</template>
