#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Eundms/issue-pr-stat 저장소에 이 프로젝트를 올린다.
#
# 사용법:
#   1) 이 스크립트가 있는 폴더(프로젝트 루트)에서 실행
#   2) bash deploy.sh
#   3) GitHub 사용자명/토큰(또는 SSH)로 인증
#
# 전제: git 설치됨, 해당 저장소에 push 권한 있음.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_SSH="git@github.com:Eundms/issue-pr-stat.git"
REPO_HTTPS="https://github.com/Eundms/issue-pr-stat.git"
BRANCH="main"

# 프로젝트 루트 = 이 스크립트가 있는 위치
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "▸ 원격 저장소를 선택하세요"
echo "  1) SSH   ($REPO_SSH)"
echo "  2) HTTPS ($REPO_HTTPS)"
read -rp "  선택 [1/2]: " choice
case "$choice" in
  1) REMOTE="$REPO_SSH" ;;
  *) REMOTE="$REPO_HTTPS" ;;
esac

# git 저장소가 아니면 초기화
if [ ! -d .git ]; then
  echo "▸ git 초기화"
  git init -q
  git branch -M "$BRANCH"
fi

# 원격 등록/갱신
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

echo "▸ 스테이징"
git add -A

if git diff --cached --quiet; then
  echo "  변경 없음 — 커밋 생략"
else
  git commit -q -m "feat: k8s-ko triage console (dashboard + collector + weekly snapshots)"
  echo "  커밋 완료"
fi

echo "▸ push (origin/$BRANCH)"
git push -u origin "$BRANCH"

cat <<'DONE'

────────────────────────────────────────────────────────────
✅ push 완료

다음 단계 (GitHub 웹에서 한 번만):

1. Settings → Actions → General → Workflow permissions
   → "Read and write permissions" 선택 후 저장
   (봇이 스냅샷을 커밋하려면 필요)

2. Settings → Pages → Build and deployment
   → Source: "GitHub Actions" 선택

3. Actions 탭 → "k8s-ko triage report" 워크플로 → "Run workflow"
   → 첫 실행이 실제 데이터를 수집하고 Pages에 배포합니다.

사이트 주소: https://eundms.github.io/issue-pr-stat/
────────────────────────────────────────────────────────────
DONE
