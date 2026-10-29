<script setup lang="ts">
// FR-035(b) 분석 취소 확인 — S2·S3 공용
import ConfirmDialog from './ConfirmDialog.vue'

defineProps<{ open: boolean; busy?: boolean; failed?: boolean }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <ConfirmDialog
    :open="open"
    :busy="busy"
    title="분석을 취소할까요?"
    confirm-label="분석 취소"
    cancel-label="계속할게요"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  >
    <p data-part="cancel-notice">지금 하던 분석을 멈춰요. 다시 하려면 새 분석을 시작해 주세요.</p>
    <p>멈추면 이번 분석 결과는 만들어지지 않아요.</p>
    <p v-if="failed" role="alert">취소하지 못했어요. 다시 시도해 주세요.</p>
  </ConfirmDialog>
</template>
