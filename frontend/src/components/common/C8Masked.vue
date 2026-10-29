<script setup lang="ts">
// C8 가림 표기 — 비식별 텍스트의 〔유형〕 을 가림 표기로 보인다. 누를 수 없고 원문 보기 조작이 없다(U8).
import { computed } from 'vue'

const props = defineProps<{ text: string | null | undefined }>()
const parts = computed(() => {
  const out: { t: string; mask: boolean }[] = []
  const s = props.text ?? ''
  const re = /〔([^〕]+)〕/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: s.slice(last, m.index), mask: false })
    out.push({ t: m[1], mask: true })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ t: s.slice(last), mask: false })
  return out
})
</script>

<template>
  <span data-c="C8"><template v-for="(p, i) in parts" :key="i"><span
    v-if="p.mask"
    class="mask"
    :aria-label="`가림, ${p.t}`"
  >〔{{ p.t }}〕</span><template v-else>{{ p.t }}</template></template></span>
</template>
