// 저장소 비밀 스캔(T146) — 비밀번호·API 키 문자열이 커밋 대상 파일에 없는지 확인한다. .env 는 git 제외라 검사하지 않는다
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const PATTERNS = [
  // dotenv 형식 줄(KEY=값)만 본다 — 코드 안의 변수 참조는 제외. 자리표시자(__…__, <…>, ${…})는 허용
  /^\s*(?:export\s+)?[A-Z_]*(?:DB_PASSWORD|API_KEY|SESSION_SECRET|RAW_FILE_KEY|CLIENT_SECRET|DATA_PORTAL_KEY|LAW_API_OC)=(?!__|$|<|\$\{|\s)[^\s#]{6,}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /(?:password|passwd|비밀번호)\s*[:=]\s*['"][^'"\s]{6,}['"]/i,
];
const SKIP = [/node_modules\//, /\.env$/, /package-lock\.json$/, /uv\.lock$/, /\.venv\//, /Intent-Plan\.md$/, /scan-secrets\.mjs$/, /\/var\//, /\.(png|jpg|pdf|hwp|hwpx|docx|gguf|ttf|ttc|woff2?)$/];

let files;
try {
  files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  files = execSync("find . -type f -not -path '*/node_modules/*' -not -path './.git/*'", { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
}
const hits = [];
for (const f of files) {
  if (SKIP.some((re) => re.test(f))) continue;
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    // 테스트 픽스처처럼 의도한 값은 같은 줄 끝에 `secrets-scan:allow` 주석을 달아 허용한다
    if (!line.includes('secrets-scan:allow') && PATTERNS.some((re) => re.test(line))) hits.push(`${f}:${i + 1}`);
  });
}
if (hits.length) {
  process.stderr.write(`비밀 의심 문자열 ${hits.length}건:\n${hits.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`비밀 스캔 통과 (${files.length}개 파일)\n`);
