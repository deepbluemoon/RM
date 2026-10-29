// 아이디·비밀번호 계정 만들기(2026-09-30). 회원가입 화면은 사용자(user)만 만들 수 있으므로 운영자 계정은 이 스크립트로 만든다.
//   npm run admin:create-account -- --login-id <아이디> --name <이름> --role operator|user   (비밀번호는 환경변수 CRD_NEW_PASSWORD 로 넘긴다 — 명령줄·기록에 남기지 않게)
//   npm run admin:create-account -- --reset-password --login-id <아이디>                   (CRD_NEW_PASSWORD 로 비밀번호 바꾸기)
//   npm run admin:create-account -- --list
// 비밀번호는 화면·로그에 출력하지 않는다
import { closePool, getPool, select } from '../src/db/pool.js';
import { ROLES, type Role } from '../src/domain/codes.js';
import { createLocalAccount, normalizeLoginId, resetPassword } from '../src/modules/auth/password.service.js';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const USAGE =
  '사용법: CRD_NEW_PASSWORD=… npm run admin:create-account -- --login-id <아이디> --name <이름> --role operator|user\n' +
  '        CRD_NEW_PASSWORD=… npm run admin:create-account -- --reset-password --login-id <아이디>\n' +
  '        npm run admin:create-account -- --list\n';

async function main() {
  if (process.argv.includes('--list')) {
    const rows = await select<{ user_id: number; login_id: string; display_name: string; role: string; last_login_at: Date | null }>(
      getPool(),
      `SELECT p.user_id, p.login_id, p.display_name, u.role, a.last_login_at
         FROM auth_password p JOIN app_user u ON u.user_id = p.user_id
         LEFT JOIN auth_identity a ON a.provider = 'local' AND a.provider_subject = p.login_id
        ORDER BY p.user_id`,
    );
    for (const r of rows) process.stdout.write(`${r.user_id}\t${r.role}\t${r.login_id}\t${r.display_name}\t최근 로그인 ${r.last_login_at ?? '-'}\n`);
    if (!rows.length) process.stdout.write('아이디·비밀번호 계정이 없습니다.\n');
    return;
  }
  const loginId = normalizeLoginId(arg('login-id'));
  const password = process.env.CRD_NEW_PASSWORD ?? '';
  if (!loginId || !password) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (process.argv.includes('--reset-password')) {
    const ok = await resetPassword(loginId, password);
    process.stdout.write(ok ? `${loginId} 비밀번호를 바꿨습니다.\n` : `${loginId} 계정이 없습니다.\n`);
    if (!ok) process.exitCode = 1;
    return;
  }
  const role = (arg('role') ?? 'user') as Role;
  if (!ROLES.includes(role)) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const u = await createLocalAccount({ loginId, password, name: arg('name') ?? loginId }, role);
  process.stdout.write(`계정을 만들었습니다: user_id=${u.userId} 아이디=${loginId} 이름=${u.name} 역할=${u.role}\n`);
}

main()
  .catch((e: Error) => {
    process.stderr.write(`실패: ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
