import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)
const parseList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
const scaleService = String(process.env.OPS_SCALE_SERVICE || '').trim()
const scaleAllowedServices = parseList(process.env.OPS_SCALE_ALLOWED_SERVICES)
const scaleBlockedServices = parseList(process.env.OPS_SCALE_BLOCKED_SERVICES || 'backend,frontend,model-server,mariadb,mysql,database,db,backend-init,backend-embed')
const scaleTarget = Number(process.env.OPS_SCALE_TARGET || 2)
const scaleMax = Number(process.env.OPS_SCALE_MAX || 5)
const scaleHardMax = 20

export const ACTIONS = [
  { id: 'scale-service', label: 'Compose 서비스 replica 수를 목표값으로 변경', description: '현재 실행 수보다 큰 목표 replica 수로 변경합니다. 자동 확장하지 않습니다.', script: 'scale-service.sh', codes: ['OPS-CPU-80-001', 'OPS-MEM-80-001'], confirmation: 'change', manualPath: '/docs/response-scripts.md', targetService: scaleService, targetReplicas: scaleTarget, maxReplicas: scaleMax, hardMaxReplicas: scaleHardMax, allowedServices: scaleAllowedServices, blockedServices: scaleBlockedServices },
  { id: 'collect-incident', label: '컨테이너 장애 정보 묶음 수집', description: '컨테이너 상태와 종료 정보를 로컬 보고서로 저장합니다. 최근 로그는 선택 사항입니다.', script: 'collect-container-incident.sh', codes: ['OPS-CPU-80-001', 'OPS-MEM-80-001', 'HTTP-5XX-RATE-001'], confirmation: 'review', includeLogs: true, manualPath: '/docs/response-scripts.md' },
  { id: 'check-docker-access', label: 'Docker 연결 상태 점검', description: 'Docker CLI, 선택된 context, Engine 연결 가능 여부를 확인합니다.', script: 'check-docker-access.sh', codes: ['OPS-DOCKER-001'], confirmation: 'review', manualPath: '/docs/response-scripts.md' },
]

const actionMap = new Map(ACTIONS.map((item) => [item.id, item]))

export function actionFor(actionId) {
  return actionMap.get(actionId) || null
}

export function canRunAction(actionId, alert = {}) {
  const action = actionFor(actionId)
  if (!action) return { allowed: false, reason: '등록되지 않은 운영 스크립트입니다' }
  if (!alert.code || !action.codes.includes(alert.code)) return { allowed: false, reason: '현재 오류코드에 허용되지 않은 스크립트입니다' }
  if (actionId === 'scale-service') {
    if (alert.stateful) return { allowed: false, reason: '데이터베이스 컨테이너는 수평 확장 대상이 아닙니다' }
    if (!action.targetService) return { allowed: false, reason: '확장 대상 Compose 서비스를 명시적으로 설정해야 합니다' }
    if (action.blockedServices.includes(action.targetService)) return { allowed: false, reason: `현재 안전 정책상 확장할 수 없는 서비스입니다: ${action.targetService}` }
    if (!action.allowedServices.includes(action.targetService)) return { allowed: false, reason: 'OPS_SCALE_ALLOWED_SERVICES에 확장 서비스를 명시해야 합니다' }
    if (!alert.composeService || alert.composeService !== action.targetService) return { allowed: false, reason: '경고 컨테이너의 Compose 서비스와 설정된 확장 대상이 일치하지 않습니다' }
    if (!Number.isInteger(action.maxReplicas) || action.maxReplicas > action.hardMaxReplicas) return { allowed: false, reason: `OPS_SCALE_MAX는 ${action.hardMaxReplicas} 이하여야 합니다` }
    if (!Number.isInteger(action.targetReplicas) || action.targetReplicas < 1 || action.targetReplicas > action.maxReplicas) return { allowed: false, reason: '목표 replica 수가 허용 범위를 벗어났습니다' }
  }
  return { allowed: true }
}

export async function runAction(actionId, { code, containerId, includeLogs = false } = {}) {
  const action = actionFor(actionId)
  if (!action) throw new Error('등록되지 않은 운영 스크립트입니다')
  if (!code || !action.codes.includes(code)) throw new Error('현재 오류코드에 허용되지 않은 스크립트입니다')
  try {
    const { stdout } = await execFileAsync('bash', [path.join(root, '..', 'scripts', action.script)], {
      env: {
        ...process.env,
        OPS_ERROR_CODE: code,
        OPS_CONTAINER_ID: containerId || '',
        OPS_INCLUDE_LOGS: includeLogs ? 'true' : 'false',
      },
      timeout: 30_000,
      maxBuffer: 1_000_000,
    })
    return { actionId, code, output: String(stdout).trim() }
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim() || '운영 스크립트 실행에 실패했습니다')
  }
}
