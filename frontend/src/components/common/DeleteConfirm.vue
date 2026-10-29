<script setup lang="ts">
// T111 삭제 확인 — FR-008·A16: 영구 삭제 + 피드백은 익명화해 보존
import ConfirmDialog from './ConfirmDialog.vue'

defineProps<{ open: boolean; busy?: boolean; failed?: boolean; name?: string }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <ConfirmDialog
    :open="open"
    :busy="busy"
    title="분석 기록을 지울까요?"
    confirm-label="완전히 지우기"
    cancel-label="취소"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  >
    <p v-if="name"><strong>{{ name }}</strong></p>
    <p data-part="delete-notice">
      올린 문서와 분석 결과가 완전히 지워지고, 되돌릴 수 없어요. 이 결과에 남긴 의견은 누가 썼는지 알 수 없게 바꿔서만 남겨 둬요.
    </p>
    <p v-if="failed" role="alert">지우지 못했어요. 다시 시도해 주세요.</p>
  </ConfirmDialog>
</template>
