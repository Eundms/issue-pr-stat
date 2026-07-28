# k8s-ko triage

`kubernetes/website`의 `language/ko` 라벨이 붙은 Issue/PR 중에서, 한글화팀이 확인해야 할 항목을 주기적으로 정리해 보여주는 정적 대시보드입니다.

배포 주소: **https://eundms.github.io/issue-pr-stat/** (첫 워크플로 실행 후 활성화)

## 배포 (최초 1회)

```bash
bash deploy.sh        # 이 폴더에서 실행 → git init → 커밋 → push
```

push 후 GitHub 웹에서 세 가지를 설정합니다.

1. **Settings → Actions → General → Workflow permissions** → "Read and write permissions"
   (봇이 주간 스냅샷을 저장소에 커밋하려면 필요)
2. **Settings → Pages → Source** → "GitHub Actions"
3. **Actions 탭 → "k8s-ko triage report" → Run workflow**
   → 첫 실행이 `kubernetes/website`에서 실제 데이터를 수집하고 Pages에 배포합니다.

첫 실행 전까지는 데모 데이터를 보여주며 상단에 배너를 띄웁니다. 이후 매주 월요일 09:10 KST에 자동 갱신됩니다.

## 분류 기준

| 분류 | 조건 | 왜 봐야 하나 |
|---|---|---|
| Issue O / PR closed | Issue OPEN + 연결된 PR이 전부 CLOSED(미병합) | 번역 작업이 중단됨 — 이슈를 닫거나 새 자원자 배정 |
| Issue O / PR stale | Issue OPEN + 연결된 OPEN PR이 `STALE_DAYS` 이상 미갱신 | 리뷰어 지정 또는 작성자 확인 필요 |
| PR long open | PR이 `LONG_OPEN_DAYS` 이상 열려 있음 | `lgtm`/`approved` 확인 후 머지 또는 정리 |
| Issue / PR 없음 | Issue OPEN + 연결 PR 없음 + `NO_PR_DAYS` 경과 | 주간 미팅에서 자원자 모집 |

Issue↔PR 연결은 GraphQL `Issue.closedByPullRequestsReferences`로 가져옵니다. GitHub 화면의 Development 패널과 같은 정보라서, PR 본문의 `Fixes #123`을 정규식으로 파싱하는 것보다 정확합니다. 링크가 걸리지 않고 언급만 된 PR은 `timelineItems(CROSS_REFERENCED_EVENT)`로 보완합니다.

## 로컬 실행

```bash
# Node 20 이상 (내장 fetch 사용, 의존성 없음)
export GITHUB_TOKEN=github_pat_xxx   # public repo 읽기만 하므로 scope 불필요
node scripts/collect.mjs             # → docs/data/report.json 생성

npx serve docs                       # → http://localhost:3000
```

`report.json`이 없으면 대시보드는 데모 데이터를 표시하고 상단에 배너를 띄웁니다. `file://`로 직접 열면 CORS 때문에 fetch가 막히므로 반드시 HTTP 서버로 띄우세요.

토큰은 절대 저장소에 커밋하지 말고 환경변수나 GitHub Secrets로만 전달하세요.

## GitHub Pages 배포

1. 이 디렉터리를 새 저장소에 push
2. Settings → Pages → Source를 **GitHub Actions**로 변경
3. Actions 탭에서 `k8s-ko triage report` 워크플로를 한 번 수동 실행

이후 매주 월요일 00:10 UTC(한국시간 09:10)에 자동 갱신됩니다. GitHub Actions의 `schedule`은 항상 UTC로 해석되며 타임존 지정을 지원하지 않습니다.

## 임계값 조정

`.github/workflows/report.yml`의 `env` 또는 로컬 환경변수로 조정합니다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `TARGET_REPO` | `kubernetes/website` | 대상 저장소 |
| `TARGET_LABEL` | `language/ko` | 대상 라벨 |
| `STALE_DAYS` | `30` | PR 정체 판정 기준 |
| `LONG_OPEN_DAYS` | `60` | PR 장기 미병합 판정 기준 |
| `NO_PR_DAYS` | `30` | 이슈 방치 판정 기준 |

## 주간 미팅 활용

각 섹션의 **마크다운 복사** 버튼을 누르면 아래 형식으로 클립보드에 담깁니다. 회의록에 그대로 붙여넣으면 됩니다.

```
* Issue는 열려 있는데 PR이 닫힌 경우
   * [#43628](https://github.com/kubernetes/website/issues/43628) 제목 — 마지막 활동 214일 (PR #43700 closed)
```

## 주차별 추이 & 스냅샷

매 실행마다 `collect.mjs`는 세 가지를 남깁니다.

| 파일 | 내용 | 보관 |
|---|---|---|
| `docs/data/report.json` | 최신 상세 (대시보드가 읽음) | 매번 덮어씀 |
| `docs/data/snapshots/YYYY-Www.json` | 그 주의 상세 원본 | 최근 `KEEP_WEEKS`주 롤링 |
| `docs/data/trend.json` | 주당 집계 한 줄 (수십 바이트) | **영구** |

DB 없이 git 히스토리를 시계열 저장소로 씁니다. 추이 그래프는 `trend.json`만 읽으므로 payload가 상수에 가깝고, "지난주 대비 −3건"은 배열의 마지막 두 항목을 빼서 구합니다. 같은 주에 두 번 실행하면 같은 주차 파일에 덮어쓰므로 멱등합니다(ISO 8601 주차, 목요일 기준).

원본 스냅샷은 `KEEP_WEEKS`(기본 8)주까지만 남기고 오래된 것은 삭제하지만, 집계는 계속 누적됩니다. 접근 빈도가 낮은 cold 원본은 버리고 hot summary만 영구 보관하는 정책입니다.

워크플로의 `Commit data` 스텝이 이 파일들을 저장소에 커밋합니다. 커밋이 다시 워크플로를 트리거하지 않도록 `push` 트리거에서 `docs/data/**`를 `paths-ignore`로 제외하고, 커밋 메시지에 `[skip ci]`를 붙였습니다. 이를 위해 워크플로 권한을 `contents: write`로 상향했습니다.

## 공유 가능한 뷰 (URL 동기화)

분류·검색·심각도·기간 필터와 정렬 상태가 쿼리스트링에 실립니다. 필터를 걸어놓고 주소를 복사하면 같은 뷰가 그대로 열립니다 — 예: `?cat=pr-long-open&sev=23`은 "장기 오픈 PR 중 90일 넘은 것만". 서버 세션 없이 URL이 상태를 들고 있어 정적 호스팅 그대로 동작합니다. `replaceState`를 써서 필터를 바꿔도 뒤로가기 히스토리가 쌓이지 않습니다.

## 참고

- [GitHub GraphQL API](https://docs.github.com/en/graphql)
- [Issue 객체 · closedByPullRequestsReferences](https://docs.github.com/en/graphql/reference/objects#issue)
- [GraphQL 리소스 제한](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)
- [Actions 워크플로 문법 · schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)
- [Actions로 GitHub Pages 배포](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-with-a-custom-github-actions-workflow)
- [Kubernetes 문서 한글화 가이드](https://kubernetes.io/ko/docs/contribute/localization/)
