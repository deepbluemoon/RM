# 01 — 계약위험탐지 프로젝트 이슈·PR 템플릿

RM의 기능 개발·오류 수정·최소 구동 점검에 사용할 공통 양식이다. AI와 사람이 같은 범위·인수 조건·검증 근거를 기준으로 작업하도록 돕는다.

## 사용할 양식

- 기능 개발·개선: .github/ISSUE_TEMPLATE/feature_request.md
- 기능 오류: .github/ISSUE_TEMPLATE/bug_report.md
- 최소 구동·실행 환경: .github/ISSUE_TEMPLATE/runtime_readiness.md
- 공통 PR 본문: [.github/pull_request_template.md](../../.github/pull_request_template.md)

PR 제목 형식과 리뷰 안내는 [CONTRIBUTING.md](../../CONTRIBUTING.md)를 따른다. PR 제목은 직접 입력하며, 본문 자동 입력은 PR 템플릿이 기본 브랜치에 반영된 뒤 사용할 수 있다.

SSH·백업 확보·컨테이너 전환은 기본 요구가 아니다. 최소 구동 조사는 현재 프로젝트에 필요한 조건을 파악하는 작업이며 설치·기동을 자동으로 포함하지 않는다.

## 파일 구성

- ISSUE.md: 최소 구동 조건 조사 이슈 예시.
- GUIDE.md: 앞으로의 작업 절차·명령·완료 판정 규칙.
- changes/.github/: 이슈 템플릿 3개와 공통 PR 템플릿의 전달·검토용 사본.
- completed/.github/: 현재 템플릿의 누적 완성본. 전체 앱 소스가 아니다.
- EXPLANATION.md: 설계 이유와 유지보수 기준.
- VERIFY.md: 검증 방법·결과·미실행 범위.
- COMMIT_MESSAGE.txt, PR.md: 이전 템플릿 정비 작업의 커밋 메시지·PR 본문 예시. 공통 양식은 루트 CONTRIBUTING.md와 .github/pull_request_template.md를 따른다.

루트 AGENTS.md에서도 GUIDE와 템플릿을 참조하므로 이후 AI 작업의 기준으로 사용할 수 있다.

## 적용 원칙

GitHub 적용 대상은 저장소 루트의 `.github/ISSUE_TEMPLATE/`와 `.github/pull_request_template.md`다. docs/ 안의 사본만 바꾸면 GitHub에는 반영되지 않는다. 적용 대상 파일을 기준으로 두 사본을 함께 갱신하고 일치를 확인한다. 현재 로컬 작성 여부와 GitHub 기본 브랜치 반영 여부는 구분한다.

작업 전 기존 변경과 브랜치를 확인한다. 적용 지침은 GUIDE.md를 따른다. AI 작업을 요청할 때 선택한 이슈와 GUIDE.md를 함께 참조하게 한다. 이 문서는 커밋·PR 생성·push를 자동으로 허용하지 않는다. 이번 변경에서 커밋·PR 생성·push는 하지 않는다.
