import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

export const ACTIONS = [
  { id: 'scale-service', label: '서비스 인스턴스 1개 늘리기', script: 'scale-service.sh', codes: ['OPS-CPU-80-001', 'OPS-MEM-80-001'] },
  { id: 'collect-diagnostics', label: 'Docker 진단 정보 수집', script: 'collect-diagnostics.sh', codes: ['OPS-DOCKER-001', 'HTTP-5XX-RATE-001'] },
]

const actionMap = new Map(ACTIONS.map((item) => [item.id, item]))

export function actionFor(actionId) {
  return actionMap.get(actionId) || null
}

export function canRunAction(actionId, alert = {}) {
  const action = actionFor(actionId)
  if (!action) return { allowed: false, reason: '등록되지 않은 운영 스크립트입니다' }
  if (!alert.code || !action.codes.includes(alert.code)) return { allowed: false, reason: '현재 오류코드에 허용되지 않은 스크립트입니다' }
  if (actionId === 'scale-service' && alert.stateful) {
    return { allowed: false, reason: 'MariaDB 컨테이너는 데이터 일관성을 위해 무조건 수평 확장하지 않습니다' }
  }
  return { allowed: true }
}

export function runAction(actionId, { code, containerId } = {}) {
  const action = actionFor(actionId)
  if (!action) return Promise.reject(new Error('등록되지 않은 운영 스크립트입니다'))
  if (!code || !action.codes.includes(code)) return Promise.reject(new Error('현재 오류코드에 허용되지 않은 스크립트입니다'))
  return new Promise((resolve, reject) => {
    const child = execFile('bash', [path.join(root, '..', 'scripts', action.script)], {
      env: {
        ...process.env,
        OPS_ERROR_CODE: code,
        OPS_CONTAINER_ID: containerId || '',
      },
      timeout: 30_000,
      maxBuffer: 1_000_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim() || '운영 스크립트 실행에 실패했습니다'))
        return
      }
      resolve({ actionId, code, output: String(stdout).trim() })
    })
    child.unref()
  })
}
