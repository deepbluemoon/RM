export const ERROR_CODES = [
  {
    code: 'OPS-CPU-80-001',
    title: '컨테이너 CPU 임계치 초과',
    severity: 'warning',
    trigger: '개별 컨테이너 CPU 사용률이 80% 이상',
    response: '대상 Compose 서비스를 1개 인스턴스 늘리는 스크립트를 실행한다',
    actionIds: ['scale-service'],
  },
  {
    code: 'OPS-MEM-80-001',
    title: '컨테이너 메모리 임계치 초과',
    severity: 'warning',
    trigger: '개별 컨테이너 메모리 사용률이 80% 이상',
    response: '대상 Compose 서비스를 1개 인스턴스 늘리는 스크립트를 실행한다',
    actionIds: ['scale-service'],
  },
  {
    code: 'OPS-DOCKER-001',
    title: 'Docker 엔진 연결 실패',
    severity: 'critical',
    trigger: 'Docker CLI가 엔진에 연결되지 않음',
    response: 'Docker 엔진과 소켓 권한을 확인하고 진단 스크립트를 실행한다',
    actionIds: ['collect-diagnostics'],
  },
]

export const ERROR_CODE_MAP = new Map(ERROR_CODES.map((item) => [item.code, item]))
