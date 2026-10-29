// PM2 설정(T147) — fork 모드 인스턴스 1개. 분석 작업 큐가 프로세스 안에 있어(research R-06) 클러스터로 늘리지 않는다.
// 비밀값은 여기 쓰지 않는다 — 앱이 backend/.env(서버에만 있음)를 읽는다.
//   pm2 start ecosystem.config.cjs --env production && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'crd-backend',
      cwd: __dirname,
      script: 'dist/src/server.js',
      exec_mode: 'fork',
      instances: 1,
      node_args: '--enable-source-maps',
      max_memory_restart: '2G',
      kill_timeout: 10000, // 종료 신호 후 진행 중 요청 정리 시간. 미완료 분석은 재기동 시 recovery 가 닫는다(차감 없음)
      restart_delay: 3000,
      time: true,
      out_file: 'var/log/crd-backend.out.log',
      error_file: 'var/log/crd-backend.err.log',
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
