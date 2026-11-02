# Windows 로컬 구동 가이드

Windows 11 PC에서 RM을 Docker 없이 띄우는 절차다. 원래 절차는 macOS 기준인 [quickstart.md](../specs/002-contract-risk-detection/quickstart.md)이고, 이 문서는 Windows에서 달라지는 점과 실제로 겪은 문제를 정리한다.

> 2026-11-02 기준. Windows 11, Node 20.20.2, Python 3.11.9, MariaDB 12.0.2에서 확인했다.

## 0. 먼저 확인

- **PR #14(`fix/windows-local-run`)의 수정이 필요하다.** 이 수정이 없으면 `db:migrate`가 오류 없이 아무것도 하지 않고 끝나고, `db:ddl-tests`가 "총 0건"으로 통과처럼 보인다. PR #14가 `main`에 병합되기 전이면 그 브랜치를 받아서 진행한다.
- **루트 `.gitignore`는 PR #20(#18)에 있다.** 병합 전 브랜치에서는 `backend/.env`가 커밋 대상으로 잡히므로 `git add .`를 쓰지 않는다. 미리 막으려면 저장소의 `.git/info/exclude`에 `.env`, `!.env.example`, `backend/var/`, `node_modules/`를 적어 둔다(이 PC에만 적용되고 커밋되지 않는다).
  ```bash
  git fetch origin && git switch fix/windows-local-run
  ```
- **LLM(M3 판정·M4 요약)은 별도다.** 모델 서버는 Ollama(`127.0.0.1:11434`)를 쓴다. Ollama가 없으면 화면에서 G5 "분석 일시 불가"가 뜨는 것이 정상이다. 분석 흐름만 확인하려면 스텁을 쓴다(5절).
- 메모리 8GB PC에서 로컬 Ollama(Qwen3 4B)를 함께 돌리면 자원이 부족하다.

## 1. 설치

모두 `winget`으로 설치한다. 관리자 권한 창이 뜨면 승인한다.

| 항목 | 명령 | 비고 |
|---|---|---|
| mise (Node 버전 관리) | `winget install jdx.mise` | 저장소 루트에서 `mise install` → Node 20 (`mise.toml`) |
| uv | `winget install astral-sh.uv` | |
| Python 3.11 | `winget install Python.Python.3.11 --scope user` | uv가 받는 Python 대신 이것을 쓴다(아래 스마트 앱 컨트롤) |
| MariaDB 12.0.2 | 아래 참고 | 11.7 미만은 마이그레이션 006의 `VECTOR` 타입 때문에 불가 |

설치 후 **터미널을 새로 열어야** PATH가 반영된다. Git Bash에서 매번 Node 20이 잡히게 하려면 `~/.bashrc`에 `eval "$(mise activate bash)"`를 넣는다.

### 스마트 앱 컨트롤

Windows 11의 스마트 앱 컨트롤이 켜져 있으면(`(Get-MpComputerStatus).SmartAppControlState`가 `On`) 서명 없는 실행 파일이 막힌다.

- uv가 내려받은 Python → `애플리케이션 제어 정책에서 이 파일을 차단했습니다` 오류. python.org Python으로 venv를 만든다.
  ```bash
  cd model-server
  uv sync --python "$LOCALAPPDATA/Programs/Python/Python311/python.exe" --extra classifiers
  ```
- venv의 `uvicorn.exe`도 막힌다. 모델 서버는 `python -m uvicorn`으로 실행한다(5절).

### MariaDB

`winget install MariaDB.Server --version 12.0.2.0`에 `/qn`(조용한 설치)을 붙이면 관리자 권한 창을 띄우지 못해 **1603 오류**로 실패한다. MSI를 받아 PowerShell에서 권한 상승해서 설치한다.

```powershell
# https://downloads.mariadb.org/rest-api/mariadb/12.0.2/mariadb-12.0.2-winx64.msi 를 받은 뒤
Start-Process msiexec -Verb RunAs -Wait -ArgumentList '/i "<msi 경로>" /qn PASSWORD=<root 비밀번호> SERVICENAME=MariaDB PORT=3306 UTF8=1'
```

Windows 서비스로 등록되어 부팅 시 자동 시작된다. root 비밀번호는 저장소 밖에 보관한다. `backend/scripts/devdb.sh`는 macOS(Homebrew) 전용이라 쓰지 않는다.

## 2. DB와 계정

root로 접속해(`"C:\Program Files\MariaDB 12.0\bin\mariadb.exe" -uroot -p -h127.0.0.1`) 앱 DB와 계정을 만든다.

```sql
CREATE DATABASE crd CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'crd'@'localhost' IDENTIFIED BY '<앱 비밀번호>';
CREATE USER 'crd'@'127.0.0.1' IDENTIFIED BY '<앱 비밀번호>';
GRANT ALL ON crd.* TO 'crd'@'localhost';         GRANT ALL ON crd.* TO 'crd'@'127.0.0.1';
GRANT ALL ON crd_test.* TO 'crd'@'localhost';    GRANT ALL ON crd_test.* TO 'crd'@'127.0.0.1';
GRANT ALL ON crd_ddltest.* TO 'crd'@'localhost'; GRANT ALL ON crd_ddltest.* TO 'crd'@'127.0.0.1';
```

## 3. 환경 변수

`backend/.env.example`을 `backend/.env`로, `model-server/.env.example`을 `model-server/.env`로 복사하고 아래 값을 바꾼다. 두 파일 모두 git 제외 대상이다(`git check-ignore -v backend/.env`로 확인. `backend/.env`는 루트 `.gitignore`(PR #20)가 있어야 제외된다).

| 파일 | 키 | 값 |
|---|---|---|
| backend/.env | `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `127.0.0.1` / `3306` / `crd` / `<앱 비밀번호>` / `crd` |
| backend/.env | `TEST_DB_PORT` / `TEST_DB_USER` / `TEST_DB_PASSWORD` | `3306` / `crd` / `<앱 비밀번호>` (`TEST_DB_NAME=crd_test` 유지) |
| backend/.env | `SESSION_SECRET`, `RAW_FILE_KEY` | 각각 64자리 hex |
| backend/.env | `MODEL_API_KEY` | 임의 값 |
| backend/.env | `AUTH_DEV_PROVIDER` | `true` (개발 모드 로그인) |
| model-server/.env | `MODEL_API_KEY` | backend와 **같은 값** |

무작위 값 만들기: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 4. 의존성과 DB 구성

```bash
npm ci --prefix backend; npm ci --prefix frontend; npm ci --prefix tools/model-api-stub
git lfs pull                                          # M1·M2 가중치(각 약 442MB)

npm run db:migrate --prefix backend                   # done (8 applied)
npm run db:check-ddl-copy --prefix backend            # DDL 사본 일치
npm run db:test:reset --prefix backend
npm run db:ddl-tests --prefix backend                 # 85 통과. "총 0"이면 PR #14 수정 누락
npm run seed:knowledge --prefix backend -- --fixture tests/fixtures/knowledge/initial.json   # 기준일 1, 근거 45
```

아이디·비밀번호 계정은 스크립트로 만든다. 비밀번호는 각자 정하고 저장소·문서에 남기지 않는다.

```bash
CRD_NEW_PASSWORD='<비밀번호>' npm run admin:create-account --prefix backend -- --login-id <아이디> --name "<이름>" --role operator
CRD_NEW_PASSWORD='<비밀번호>' npm run admin:create-account --prefix backend -- --login-id <아이디> --name "<이름>" --role user
```

## 5. 실행

터미널 3개를 쓴다. 9542 포트에는 스텁과 모델 서버 중 하나만 띄운다.

```bash
# 1) 9542 — 흐름 확인용 스텁(LLM 없이 S1~S4가 끝까지 돈다)
MODEL_API_KEY=<backend와 같은 값> npm run dev --prefix tools/model-api-stub
#    또는 실모델 서버(M1·M2 실모델, M3·M4는 Ollama 필요)
cd model-server && uv run python -m uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1

# 2) 백엔드 :9522
cd backend && npm run dev

# 3) 프런트 :9502 — 이 PC에서만 열리게 127.0.0.1로 띄운다
cd frontend && npm run dev -- --host 127.0.0.1
```

브라우저에서 http://127.0.0.1:9502 에 접속한다.

> `vite.config.ts`의 `host`가 `0.0.0.0`(원래 서버의 Nginx 연결용)이라, `--host 127.0.0.1` 없이 띄우면 같은 와이파이의 다른 기기에서 접속해 로그인할 수 있다. 첫 실행 때 Windows 방화벽 허용 창이 뜨면 거부해도 로컬 사용에는 문제가 없다.

## 6. 확인

| 확인 | 명령 | 기대 결과 |
|---|---|---|
| 백엔드 타입 검사 | `npm run typecheck --prefix backend` | 오류 없음 |
| 백엔드 테스트 | `npx vitest run` (backend, 스텁 기준) | 2026-11-02 기준 386 통과, 3 실패(아래), 2 건너뜀 |
| 프런트 단위 테스트 | `npx vitest run` (frontend) | 106/106 |
| 모델 서버 테스트 | `uv run pytest` (model-server) | 65/65 |
| 모델 서버 상태 | `curl -H "Authorization: Bearer <키>" http://127.0.0.1:9542/health` | M1·M2 `ready`. Ollama가 없으면 M3·M4 `error` |

알려진 백엔드 테스트 실패: `web-api.contract.test.ts` 2건은 `model-server/docs/service-test-result.json`이 저장소에 없어서, `us1-analysis-flow.test.ts` 판정 순서 1건은 전체 실행 중에만 간헐적으로 실패한다(단독 실행 시 통과).

## 7. 자주 겪는 문제

| 증상 | 원인 | 해결 |
|---|---|---|
| `db:migrate`가 아무 출력 없이 끝남 | Windows 경로(`/C:/...`) 버그 | PR #14 수정 적용 |
| `DDL 규칙 테스트: 0 통과, 0 실패 (총 0)` | `core.autocrlf`로 SQL이 CRLF가 됨 | PR #14 수정 적용 |
| `애플리케이션 제어 정책에서 이 파일을 차단했습니다` | 스마트 앱 컨트롤 | python.org Python + `python -m uvicorn` |
| MariaDB 설치 1603 | 조용한 설치에서 권한 상승 불가 | `Start-Process msiexec -Verb RunAs` |
| 화면에 G5 "분석 일시 불가" | M3·M4(Ollama) 미연결 | 정상. 흐름 확인은 스텁 사용 |
| 로그인 실패 | 새 DB라 계정이 없음 | 4절 계정 생성 |
| Git Bash curl로 보낸 한글 JSON이 깨짐 | 인자 인코딩 | 본문을 UTF-8 파일로 만들어 `--data-binary @파일` |
| 새 터미널에서 `mise`·`uv`·`gh`를 못 찾음 | PATH 미반영 | 터미널을 새로 연다 |
