export const ERROR_CODES = [
  {
    code: 'OPS-CPU-80-001',
    title: '컨테이너 CPU 임계치 초과',
    severity: 'warning',
    trigger: '개별 컨테이너 CPU 사용률이 80% 이상',
    response: '컨테이너 장애 정보 수집을 검토한다. 서비스 확장은 사람이 별도로 판단한다',
    actionIds: ['collect-incident', 'scale-service'],
  },
  {
    code: 'OPS-MEM-80-001',
    title: '컨테이너 메모리 임계치 초과',
    severity: 'warning',
    trigger: '개별 컨테이너 메모리 사용률이 80% 이상',
    response: '컨테이너 장애 정보 수집을 검토한다. 서비스 확장은 사람이 별도로 판단한다',
    actionIds: ['collect-incident', 'scale-service'],
  },
  {
    code: 'OPS-DOCKER-001',
    title: 'Docker 엔진 연결 실패',
    severity: 'critical',
    trigger: 'Docker CLI가 엔진에 연결되지 않음',
    response: 'Docker Desktop/Engine 실행 상태와 context·권한을 사람이 확인한다',
    actionIds: ['check-docker-access'],
  },
  {
    code: 'HTTP-404-RATE-001',
    title: 'HTTP 404 비율 급증',
    severity: 'warning',
    trigger: '컨테이너 access log에서 HTTP 404가 20% 이상, 최소 10건 이상 지속',
    response: '라우팅·배포 누락을 확인한다. 자동 스크립트는 실행하지 않는다',
    actionIds: [],
  },
  {
    code: 'HTTP-429-RATE-001',
    title: 'HTTP 429 비율 급증',
    severity: 'warning',
    trigger: '컨테이너 access log에서 HTTP 429가 10% 이상, 최소 10건 이상 지속',
    response: 'rate limit과 호출자 폭주를 확인한다. 자동 스크립트는 실행하지 않는다',
    actionIds: [],
  },
  {
    code: 'HTTP-5XX-RATE-001',
    title: 'HTTP 5xx 비율 급증',
    severity: 'critical',
    trigger: '컨테이너 access log에서 HTTP 5xx가 5% 이상, 최소 10건 이상 지속',
    response: '컨테이너 장애 정보 수집을 검토한다. 자동 롤백·확장은 하지 않는다',
    actionIds: ['collect-incident'],
  },
]

export const ERROR_CODE_MAP = new Map(ERROR_CODES.map((item) => [item.code, item]))
