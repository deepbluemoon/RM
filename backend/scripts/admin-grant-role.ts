// 역할 부여(T027, RBAC). 자가 가입은 user 만 가능하다(G14) — 운영자·개발자·법률 전문가는 이 스크립트로만 만든다.
//   npm run admin:grant-role -- --list
//   npm run admin:grant-role -- --user-id <번호> --role operator|developer|legal_expert|user
//   npm run admin:grant-role -- --provider kakao|naver|dev --subject <제공자 사용자 번호> --role …
// 대상 계정이 없으면 먼저 한 번 로그인하도록 안내한다. 역할은 다음 요청부터 바로 적용된다(authenticate 가 매 요청 DB 에서 읽음)
import { grantRole, grantRoleByUserId, listAccounts } from '../src/modules/auth/auth.service.js';
import { closePool } from '../src/db/pool.js';
import { ROLES, type Role } from '../src/domain/codes.js';
import { permissionsOf } from '../src/modules/auth/rbac.js';
import { loadRoleMatrix } from '../src/modules/auth/rbac.service.js';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const USAGE =
  '사용법: npm run admin:grant-role -- --list\n' +
  '        npm run admin:grant-role -- --user-id <번호> --role operator|developer|legal_expert|user\n' +
  '        npm run admin:grant-role -- --provider kakao|naver|dev --subject <id> --role …\n';

async function main() {
  if (process.argv.includes('--list')) {
    const rows = await listAccounts();
    for (const r of rows) process.stdout.write(`${r.user_id}\t${r.role}\t${r.provider}/${r.provider_subject}\t최근 로그인 ${r.last_login_at ?? '-'}\n`);
    if (!rows.length) process.stdout.write('로그인한 계정이 없습니다.\n');
    return;
  }
  const role = arg('role') as Role | undefined;
  if (!role || !ROLES.includes(role)) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const userId = arg('user-id');
  const provider = arg('provider');
  const subject = arg('subject');
  let ok: boolean;
  if (userId && /^\d+$/.test(userId)) ok = await grantRoleByUserId(Number(userId), role);
  else if (provider && ['kakao', 'naver', 'dev'].includes(provider) && subject) ok = await grantRole(provider as 'kakao', subject, role);
  else {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (!ok) {
    process.stderr.write('해당 계정이 없습니다. 먼저 한 번 로그인하세요(--list 로 확인).\n');
    process.exitCode = 1;
    return;
  }
  await loadRoleMatrix();
  process.stdout.write(`역할 부여 완료: ${userId ? `user ${userId}` : `${provider}/${subject}`} → ${role} (권한: ${permissionsOf(role).join(', ')})\n`);
}

main().finally(() => closePool());
