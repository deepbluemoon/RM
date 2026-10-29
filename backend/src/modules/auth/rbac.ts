// RBAC 단일 지점 — 역할(사용자 유형) → 권한 → API 경로. 권한은 유스케이스(design/UC_00 §3, UC_ALL §3·§5) 하나 또는 그 일부와 1:1 이다.
//   초기값(DEFAULT_ROLE_PERMISSIONS): 사용자 → UC1~UC6, 운영자 → UC7~UC10·권한 관리, 법률 전문가 → UC8 검수, 개발자 → UC10
//   실제 값은 role_permission 테이블(migration 005) — 권한 관리 화면(S10, /admin/rbac)에서 바꾼다. rbac.service.ts 가 읽어 여기 캐시에 싣는다.
// UC4 사업자관점자가점검은 로컬 사업자 모드에서 결과 화면(S4-B)이 곧 사업자 관점이라 result.view 에 포함된다.
// 역할 부여(계정 → 역할) = npm run admin:grant-role (자가 가입은 user 만 — G14)
import { ROLES, type Role } from '../../domain/codes.js';

export const PERMISSIONS = [
  'analysis.request', // UC1 계약문서분석요청
  'result.view', // UC2 위험조항결과조회 (+UC4 사업자 관점)
  'explanation.view', // UC3 위험설명및근거비교열람
  'history.manage', // UC5 분석기록관리
  'feedback.submit', // UC6 판정피드백제출
  'knowledge.manage', // UC7 근거데이터갱신
  'eval.run', // UC8 탐지품질평가 — 실행·기록·확정·비교(운영자)
  'eval.review', // UC8 탐지품질평가 — 평가 데이터 검수·근거 적합성 판정(법률 전문가, 운영자 대리 입력)
  'feedback.review', // UC9 사용자피드백검토
  'modelApi.view', // UC10 API활용안내열람 — 안내·내 API 키 발급
  'modelApi.manage', // UC10 운영 — 서버 상태·매뉴얼·점검 문서·전체 API 키 관리(운영자)
  'rbac.manage', // 권한 관리(이 표 자체) — 유스케이스 밖 운영 기능
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type PermissionArea = 'user' | 'ops' | 'admin';
/** 권한 관리 화면(S10)이 보여 줄 이름·근거 유스케이스·영역 */
export const PERMISSION_META: Record<Permission, { label: string; uc: string; area: PermissionArea }> = {
  'analysis.request': { label: '계약 문서 분석 요청', uc: 'UC1', area: 'user' },
  'result.view': { label: '위험 조항 결과 조회(사업자 관점 포함)', uc: 'UC2·UC4', area: 'user' },
  'explanation.view': { label: '위험 설명·근거 비교 열람', uc: 'UC3', area: 'user' },
  'history.manage': { label: '분석 기록 관리·재분석', uc: 'UC5', area: 'user' },
  'feedback.submit': { label: '판정 피드백 제출', uc: 'UC6', area: 'user' },
  'knowledge.manage': { label: '근거 데이터 갱신', uc: 'UC7', area: 'ops' },
  'eval.run': { label: '탐지 품질 평가 — 실행·기록·확정', uc: 'UC8', area: 'ops' },
  'eval.review': { label: '탐지 품질 평가 — 전문가 검수', uc: 'UC8', area: 'ops' },
  'feedback.review': { label: '사용자 피드백 검토', uc: 'UC9', area: 'ops' },
  'modelApi.view': { label: 'API 활용 안내·내 API 키 발급', uc: 'UC10', area: 'user' },
  'modelApi.manage': { label: 'API 서버 상태·운영 문서·전체 키 관리', uc: 'UC10', area: 'ops' },
  'rbac.manage': { label: '권한 관리', uc: '—', area: 'admin' },
};

export const ROLE_LABEL: Record<Role, string> = { user: '사용자', operator: '운영자', legal_expert: '법률 전문가', developer: '개발자' };

export type RoleMatrix = Record<Role, readonly Permission[]>;

/** 초기값(= migration 005 시드). DB 를 읽기 전·행이 없는 칸은 이 값을 쓴다 */
export const DEFAULT_ROLE_PERMISSIONS: RoleMatrix = {
  user: ['analysis.request', 'result.view', 'explanation.view', 'history.manage', 'feedback.submit', 'modelApi.view'],
  operator: ['knowledge.manage', 'eval.run', 'eval.review', 'feedback.review', 'modelApi.view', 'modelApi.manage', 'rbac.manage'],
  legal_expert: ['eval.review'],
  developer: ['modelApi.view', 'modelApi.manage'],
};

/** 끌 수 없는 칸 — 운영자의 권한 관리를 끄면 아무도 되돌릴 수 없다(잠김 방지) */
export const LOCKED: readonly { role: Role; perm: Permission }[] = [{ role: 'operator', perm: 'rbac.manage' }];
export const isLocked = (role: Role, perm: Permission): boolean => LOCKED.some((l) => l.role === role && l.perm === perm);

/** 표준 순서(PERMISSIONS 순)로 정리하고 잠긴 칸을 켠다 */
export function normalizeMatrix(m: Partial<Record<Role, readonly string[]>>): RoleMatrix {
  const out = {} as Record<Role, Permission[]>;
  for (const role of ROLES) {
    const set = new Set(m[role] ?? []);
    out[role] = PERMISSIONS.filter((p) => set.has(p) || isLocked(role, p));
  }
  return out;
}

let current: RoleMatrix = normalizeMatrix(DEFAULT_ROLE_PERMISSIONS);
let loadedAt = 0;

/** rbac.service.ts 만 부른다 */
export function setRoleMatrix(m: RoleMatrix): void {
  current = normalizeMatrix(m);
  loadedAt = Date.now();
}
export const roleMatrix = (): RoleMatrix => current;
export const matrixAgeMs = (): number => (loadedAt ? Date.now() - loadedAt : Infinity);

export const permissionsOf = (role: Role): readonly Permission[] => current[role] ?? [];
export const can = (role: Role, perm: Permission): boolean => permissionsOf(role).includes(perm);

/** 로그인 없이 부를 수 있는 경로(/api 뒤). 로그인·세션 확인·코드 사전·개인정보 고지·모델 서버 상태,
 *  외부 프로그램용 모델 API(/model/…) — 세션 대신 발급받은 API 키로 확인한다(modelApiGuide/apiKey.service.ts) */
const PUBLIC: RegExp[] = [/^\/auth\//, /^\/session$/, /^\/meta\//, /^\/model-server\/status$/, /^\/model\//];

type Rule = { method?: string; path: RegExp; perm: Permission };

/** 위에서부터 처음 맞는 규칙. 더 구체적인 경로를 먼저 둔다 */
const RULES: Rule[] = [
  // UC1
  { path: /^\/intake\//, perm: 'analysis.request' },
  { path: /^\/analyses(\/|$)/, perm: 'analysis.request' },
  // UC3 — 설명·원문 대조·유사 사례
  { path: /^\/results\/[^/]+\/clauses\/[^/]+\/(explanation|comparison|similar-cases)$/, perm: 'explanation.view' },
  // UC5 — 근거 변경 영향 안내는 기록 관리의 일부
  { path: /^\/results\/[^/]+\/impacts$/, perm: 'history.manage' },
  // UC2
  { path: /^\/results\//, perm: 'result.view' },
  { path: /^\/evidence\//, perm: 'result.view' },
  // UC5
  { path: /^\/history(\/|$)/, perm: 'history.manage' },
  // UC6
  { path: /^\/feedback(\/|$)/, perm: 'feedback.submit' },
  // UC7
  { path: /^\/admin\/knowledge(\/|$)/, perm: 'knowledge.manage' },
  // UC8 — 전문가 검수 화면(S7-E)이 쓰는 경로
  { method: 'GET', path: /^\/admin\/eval\/overview$/, perm: 'eval.review' },
  { method: 'GET', path: /^\/admin\/eval\/items$/, perm: 'eval.review' },
  { method: 'POST', path: /^\/admin\/eval\/items\/[^/]+\/review$/, perm: 'eval.review' },
  { path: /^\/admin\/eval\/runs\/[^/]+\/evidence-reviews(\/|$)/, perm: 'eval.review' },
  { path: /^\/admin\/eval(\/|$)/, perm: 'eval.run' },
  // UC9
  { path: /^\/admin\/feedback(\/|$)/, perm: 'feedback.review' },
  // UC10 — 서버 상태·운영 문서·전체 키 관리는 운영자, 안내·OpenAPI·Try it out·내 키는 사용자도
  { method: 'GET', path: /^\/admin\/model-api\/(status|docs\/[^/]+)$/, perm: 'modelApi.manage' },
  { path: /^\/admin\/api-keys(\/|$)/, perm: 'modelApi.manage' },
  { path: /^\/admin\/model-api(\/|$)/, perm: 'modelApi.view' },
  { path: /^\/api-keys(\/|$)/, perm: 'modelApi.view' },
  // 권한 관리(S10)
  { path: /^\/admin\/rbac(\/|$)/, perm: 'rbac.manage' },
];

export type Requirement = { kind: 'public' } | { kind: 'login' } | { kind: 'perm'; perm: Permission };

/** 경로가 요구하는 것. 규칙에 없는 경로는 로그인만 요구한다(없는 경로면 이어서 404) */
export function requirementOf(method: string, path: string): Requirement {
  if (PUBLIC.some((re) => re.test(path))) return { kind: 'public' };
  const m = method === 'HEAD' ? 'GET' : method;
  const rule = RULES.find((r) => (!r.method || r.method === m) && r.path.test(path));
  return rule ? { kind: 'perm', perm: rule.perm } : { kind: 'login' };
}
