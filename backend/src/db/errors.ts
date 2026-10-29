// DB 규칙 위반을 도메인 오류로 번역한다(T018). 규칙은 DB(CHECK·트리거)가 판정하고 앱은 다시 구현하지 않는다.
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 409 | 422 | 400 | 404 = 409,
    public readonly br?: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

interface SqlErr {
  errno?: number;
  sqlState?: string;
  code?: string;
  sqlMessage?: string;
}

/** SQLSTATE 45000(트리거 SIGNAL)·CHECK 위반(4025)·중복 키(1062)를 DomainError 로 바꾼다. 그 밖은 그대로 던진다 */
export function translateDbError(e: unknown): never {
  const err = e as SqlErr;
  const msg = err.sqlMessage ?? '';
  if (err.sqlState === '45000') {
    const br = msg.split(':')[0]?.trim();
    throw new DomainError('rule_violation', msg, 409, br);
  }
  if (err.errno === 4025 || err.code === 'ER_CONSTRAINT_FAILED' || err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    const m = /CONSTRAINT `([^`]+)`/.exec(msg);
    throw new DomainError('check_violation', m ? `제약 위반: ${m[1]}` : '제약 위반', 422, m?.[1]);
  }
  if (err.errno === 1062 || err.code === 'ER_DUP_ENTRY') {
    throw new DomainError('duplicate', '이미 존재합니다', 409);
  }
  throw e;
}

export function isDuplicate(e: unknown): boolean {
  const err = e as SqlErr;
  return err.errno === 1062 || err.code === 'ER_DUP_ENTRY';
}

/** 트리거·CHECK 위반인지(재시도 없이 사용자·운영 오류로 처리할 대상) */
export function isRuleViolation(e: unknown): boolean {
  const err = e as SqlErr;
  return err.sqlState === '45000' || err.errno === 4025;
}
