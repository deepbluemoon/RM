<script setup lang="ts">
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
</script>

<template>
  <div class="page narrow">
    <div class="page-head"><h1 class="t-display-xl">페이지를 찾을 수 없어요</h1></div>
    <div class="section tight">
      <C7AreaPlaceholder kind="na" text="주소가 바뀌었거나 없는 화면이에요. 처음 화면에서 다시 시작해 주세요.">
        <p class="mt-md"><RouterLink to="/">새 분석 시작</RouterLink></p>
      </C7AreaPlaceholder>
    </div>
  </div>
</template>
