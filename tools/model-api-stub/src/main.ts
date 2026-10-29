import { createStubApp } from './server.js';

// 이 서버의 8000 번은 다른 계정이 쓰고 있어 9542 을 기본으로 한다(계약 기본값 8000 은 MODEL_API_BASE_URL 로 바꿀 수 있음)
const port = Number(process.env.PORT ?? 9542);
const { app, config } = createStubApp();
app.listen(port, '127.0.0.1', () => {
  process.stdout.write(`model-api-stub listening on http://127.0.0.1:${port} (health=${config.health}, cold=${config.cold})\n`);
});
