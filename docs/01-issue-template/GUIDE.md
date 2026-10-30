# 작업 안내

## 작업 시작

저장소 루트의 WSL 터미널 기준 예시다. 현재 작업에 필요한 명령을 선택한다.

```bash
cd /home/euclid/rm
git status --short
git branch --show-current
git diff -- .github/ISSUE_TEMPLATE docs/01-issue-template
git diff --cached -- .github/ISSUE_TEMPLATE docs/01-issue-template
```

기존 변경과 스테이징을 보존한다. 새 파일은 diff에 나오지 않을 수 있으므로 직접 읽는다. 현재 브랜치가 작업 목적에 맞으면 유지한다. 별도 브랜치가 필요할 때만 겹치지 않는 이름으로 만들고 기존 브랜치를 삭제하지 않는다.

## 앞으로의 작업 절차

1. 기능 개발은 feature_request, 오류 수정은 bug_report, 최소 구동 조사는 runtime_readiness를 선택한다.
2. 커밋·환경·관련 명세와 기존 변경을 기록한다. 경로·자산·접근 가능 여부를 가정하지 않는다.
3. 목표·변경 범위·제외 범위·인수 조건을 먼저 채운다. 구동 점검은 조사 / 구현 / 검증과 스텁 / 외부 연결 / 독립 실모델을 선택한다.
4. 필요한 코드·설정·명세를 조사한다. 모델·DB·근거 데이터는 해당 기능에 필요한 경우에만 포함한다.
5. 구현 작업은 관련 파일을 수정하고 영향에 맞는 기존 테스트·빌드·수동 확인을 선택한다. 문서 변경만으로 앱 전체 테스트를 요구하지 않는다.
6. 실제 결과와 근거를 기록하고 완료 조건을 판정한다. 범위 밖 작업은 후속 작업으로 남긴다.

## AI와 사람의 공통 완료 규칙

- 상태는 통과 / 실패 / 미실행 / 차단 / 해당 없음으로 기록한다.
- 통과에는 명령·입력·관찰 결과 또는 조사 근거를 연결한다. 실패·미실행·차단을 완료 표시로 숨기지 않는다.
- 해당 없음은 이유를 적는다. 차단은 필요한 입력·자산·권한과 영향·다음 조치를 적는다.
- 조사는 최소 조건·근거·부족한 조건·후속 조치가 정리되면 완료할 수 있다. 실제 기동 성공은 별도 검증이다.
- 구현·검증은 필수 인수 조건이 통과해야 완료다. 필수 검증이 남으면 부분 완료와 남은 항목을 보고한다.
- 정적 분석, 스텁 실행, heuristic 실행, 실모델 실행을 구분한다. 소수 예제나 HTTP 성공을 전체 탐지 정확도로 일반화하지 않는다.
- SSH·백업·컨테이너화는 목표에 필요하고 요청된 경우에만 수행한다. 운영 비밀값·계약서 원문·개인정보는 이슈와 저장소에 넣지 않는다.

## 템플릿 유지보수

실제 적용본 .github/ISSUE_TEMPLATE/을 기준으로 수정한 뒤 아래 두 위치를 같은 내용으로 갱신한다.

- docs/01-issue-template/changes/.github/ISSUE_TEMPLATE/
- docs/01-issue-template/completed/.github/ISSUE_TEMPLATE/

패키지만 받은 경우 파일별로 비교해 적용한다. 기존 .github 폴더 전체를 덮어쓰지 않는다. 템플릿 추가·삭제 시 세 위치와 안내·검증 문서를 함께 갱신한다.

## 커밋과 push 전 검토

아래는 사용자가 로컬 커밋을 하기로 결정한 경우의 예시다. 이번 수정에서는 스테이징·커밋·PR 생성·push를 실행하지 않는다.

```bash
git add .github/ISSUE_TEMPLATE/runtime_readiness.md .github/ISSUE_TEMPLATE/bug_report.md .github/ISSUE_TEMPLATE/feature_request.md docs/01-issue-template
git diff --cached --stat
git diff --cached --check
git diff --cached
git commit -F docs/01-issue-template/COMMIT_MESSAGE.txt
```

이미 스테이징된 다른 변경도 커밋에 포함될 수 있으므로 전체 staged diff를 확인한다. push는 사용자의 별도 명시적 지시를 받은 뒤에만 실행한다. 사용자가 나중에 push할 예정이라는 말만으로 대신 실행하지 않는다.
