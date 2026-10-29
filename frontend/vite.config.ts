/// <reference types="vitest" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    // 공용 Nginx(p02.conf)가 https://p2.sumzip.com → 192.168.0.19:9502 로 넘긴다 — LAN 에서 받도록 모든 인터페이스에 연다
    host: '0.0.0.0',
    port: 9502,
    strictPort: true,
    allowedHosts: ['p2.sumzip.com', 'localhost', '127.0.0.1'],
    proxy: {
      // '/api/' 로만 맞춘다 — 화면 경로 /api-guide(API 활용)가 백엔드로 넘어가지 않게
      '^/api/': { target: 'http://127.0.0.1:9522', changeOrigin: false },
      // https://p2.sumzip.com/docs — 모델 서버(FastAPI)의 Swagger UI 를 그대로 보여 준다(모델 서버는 127.0.0.1 전용)
      '^/docs(?:[/?#]|$)': { target: 'http://127.0.0.1:9542', changeOrigin: true },
      // Swagger 가 읽는 명세 — 백엔드가 servers(/api/admin/model-api/try 프록시)·Bearer Authorize 를 붙여 준다. 키는 넣지 않음
      '^/openapi\\.json(?:\\?.*)?$': {
        target: 'http://127.0.0.1:9522',
        changeOrigin: false,
        rewrite: () => '/api/admin/model-api/openapi?view=docs',
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.spec.ts'],
    globals: false,
  },
})
