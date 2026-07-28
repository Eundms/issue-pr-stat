#!/usr/bin/env node
/**
 * kubernetes/website 의 language/ko Issue/PR 을 수집해서
 * 한글화팀이 "확인이 필요한" 항목으로 분류한 report.json 을 생성한다.
 *
 * 의존성 없음 (Node 20+ 내장 fetch 사용)
 *
 * 실행:
 *   GITHUB_TOKEN=ghp_xxx node scripts/collect.mjs
 */

import { writeFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// 설정 (환경변수로 오버라이드 가능)
// ---------------------------------------------------------------------------
const CONFIG = {
  repo: process.env.TARGET_REPO ?? "kubernetes/website",
  label: process.env.TARGET_LABEL ?? "language/ko",
  /** 연결된 PR이 이 기간 동안 갱신되지 않으면 "정체"로 본다 */
  staleDays: num(process.env.STALE_DAYS, 30),
  /** PR이 이 기간 이상 열려 있으면 "장기 미병합"으로 본다 */
  longOpenDays: num(process.env.LONG_OPEN_DAYS, 60),
  /** 이슈가 이 기간 이상 PR 없이 방치되면 "담당자 필요"로 본다 */
  noPrDays: num(process.env.NO_PR_DAYS, 30),
  out: process.env.OUT ?? "docs/data/report.json",
  /** 스냅샷 원본을 보관할 디렉터리 (주차별 파일) */
  snapshotDir: process.env.SNAPSHOT_DIR ?? "docs/data/snapshots",
  /** 집계만 담는 추이 파일 (영구 보관) */
  trendOut: process.env.TREND_OUT ?? "docs/data/trend.json",
  /** 원본 스냅샷을 몇 주까지 롤링 보관할지 (집계는 무관하게 영구) */
  keepWeeks: num(process.env.KEEP_WEEKS, 8),
  token: process.env.GITHUB_TOKEN,
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

if (!CONFIG.token) {
  console.error(
    "GITHUB_TOKEN 이 필요합니다. public repo 조회만 하므로 scope 없는 fine-grained token 이면 충분합니다."
  );
  process.exit(1);
}

const API = "https://api.github.com/graphql";
const DAY_MS = 86_400_000;
const NOW = Date.now();

// ---------------------------------------------------------------------------
// GraphQL 클라이언트 (429/5xx 지수 백오프 재시도)
// ---------------------------------------------------------------------------
async function gql(query, variables, attempt = 0) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      "Content-Type": "application/json",
      "User-Agent": "k8s-ko-triage",
    },
    body: JSON.stringify({ query, variables }),
  });

  if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 5) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 2 ** attempt * 1000;
    console.warn(`  ↻ HTTP ${res.status} — ${waitMs}ms 후 재시도 (${attempt + 1}/5)`);
    await sleep(waitMs);
    return gql(query, variables, attempt + 1);
  }

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

  const body = await res.json();
  if (body.errors?.length) {
    throw new Error("GraphQL error: " + JSON.stringify(body.errors, null, 2));
  }
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** search 커넥션을 끝까지 순회한다. GraphQL search 는 최대 1000건까지만 페이징된다. */
async function searchAll(query, searchQuery) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await gql(query, { q: searchQuery, after });
    nodes.push(...data.search.nodes.filter(Boolean));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// 쿼리
// ---------------------------------------------------------------------------
const PR_FIELDS = `
  number title url state isDraft createdAt updatedAt mergedAt
  author { login }
  labels(first: 30) { nodes { name } }
`;

const ISSUE_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number title url state createdAt updatedAt
        author { login }
        assignees(first: 5) { nodes { login } }
        labels(first: 30) { nodes { name } }
        comments { totalCount }
        # GitHub Development 패널과 동일한 "이 이슈를 닫는 PR" 링크
        closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
          nodes { ${PR_FIELDS} }
        }
        # 링크가 안 걸린 채 본문에서만 언급된 PR 보완용
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 30) {
          nodes {
            ... on CrossReferencedEvent {
              willCloseTarget
              source { ... on PullRequest { ${PR_FIELDS} } }
            }
          }
        }
      }
    }
  }
}`;

const PULL_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        ${PR_FIELDS}
        reviewDecision
        comments { totalCount }
        closingIssuesReferences(first: 10) {
          nodes { number url title state }
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// 정규화 헬퍼
// ---------------------------------------------------------------------------
const daysSince = (iso) => Math.floor((NOW - new Date(iso).getTime()) / DAY_MS);
const labelNames = (n) => (n.labels?.nodes ?? []).map((l) => l.name);

/** Prow 워크플로 상태를 한눈에 보기 위한 플래그 */
function prowFlags(labels) {
  return {
    lgtm: labels.includes("lgtm"),
    approved: labels.includes("approved"),
    hold: labels.some((l) => l.startsWith("do-not-merge")),
    needsRebase: labels.includes("needs-rebase"),
    cncfUnsigned: labels.includes("cncf-cla: no"),
  };
}

function normalizePr(pr) {
  const labels = labelNames(pr);
  const closingIssues = (pr.closingIssuesReferences?.nodes ?? []).map((i) => ({
    number: i.number,
    url: i.url,
    title: i.title,
    state: i.state,
  }));
  return {
    ...(closingIssues.length ? { closingIssues } : {}),
    number: pr.number,
    title: pr.title,
    url: pr.url,
    // GraphQL PullRequestState: OPEN | CLOSED | MERGED
    state: pr.mergedAt ? "MERGED" : pr.state,
    isDraft: pr.isDraft ?? false,
    author: pr.author?.login ?? "ghost",
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt ?? null,
    ageDays: daysSince(pr.createdAt),
    idleDays: daysSince(pr.updatedAt),
    reviewDecision: pr.reviewDecision ?? null,
    labels,
    flags: prowFlags(labels),
  };
}

function normalizeIssue(issue) {
  // 두 경로에서 얻은 PR 을 number 기준으로 dedupe
  const byNumber = new Map();
  for (const pr of issue.closedByPullRequestsReferences?.nodes ?? []) {
    if (pr) byNumber.set(pr.number, pr);
  }
  for (const ev of issue.timelineItems?.nodes ?? []) {
    const pr = ev?.source;
    if (pr?.number != null && !byNumber.has(pr.number)) byNumber.set(pr.number, pr);
  }

  const linkedPrs = [...byNumber.values()]
    .map(normalizePr)
    .sort((a, b) => b.number - a.number);

  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    author: issue.author?.login ?? "ghost",
    assignees: (issue.assignees?.nodes ?? []).map((a) => a.login),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ageDays: daysSince(issue.createdAt),
    idleDays: daysSince(issue.updatedAt),
    comments: issue.comments?.totalCount ?? 0,
    labels: labelNames(issue),
    linkedPrs,
  };
}

// ---------------------------------------------------------------------------
// 분류 규칙
// ---------------------------------------------------------------------------
function classify(issues, prs) {
  const { staleDays, longOpenDays, noPrDays } = CONFIG;

  // 1) Issue OPEN + 연결된 PR이 전부 CLOSED(미병합) → 작업이 중단된 상태
  const issuePrClosed = issues
    .filter((i) => {
      const prs = i.linkedPrs;
      return prs.length > 0 && prs.every((p) => p.state === "CLOSED");
    })
    .map((i) => ({ ...i, sortKey: i.idleDays }));

  // 2) Issue OPEN + 연결된 PR은 OPEN이지만 오래 갱신 없음 → 리뷰/응답 촉구 필요
  const issuePrStale = issues
    .filter((i) => {
      const open = i.linkedPrs.filter((p) => p.state === "OPEN");
      return open.length > 0 && open.every((p) => p.idleDays >= staleDays);
    })
    .map((i) => ({
      ...i,
      sortKey: Math.max(...i.linkedPrs.filter((p) => p.state === "OPEN").map((p) => p.idleDays)),
    }));

  // 3) Issue OPEN + 연결된 PR 자체가 없음 → 자원자 모집 필요
  const issueNoPr = issues
    .filter((i) => i.linkedPrs.length === 0 && i.ageDays >= noPrDays)
    .map((i) => ({ ...i, sortKey: i.ageDays }));

  // 4) 너무 오래 열려 있는 PR → 머지 또는 정리 결정 필요
  const prLongOpen = prs
    .filter((p) => p.state === "OPEN" && p.ageDays >= longOpenDays)
    .map((p) => ({ ...p, sortKey: p.ageDays }));

  const desc = (a, b) => b.sortKey - a.sortKey;

  return [
    {
      id: "issue-pr-closed",
      title: "Issue는 열려 있는데 PR이 닫힌 경우",
      hint: "번역 작업이 중단된 상태입니다. 이슈를 닫거나 새 자원자를 찾아야 합니다.",
      kind: "issue",
      metric: "마지막 활동",
      items: issuePrClosed.sort(desc),
    },
    {
      id: "issue-pr-stale",
      title: "Issue와 PR 모두 열려 있지만 정체된 경우",
      hint: `연결된 PR이 ${staleDays}일 이상 움직이지 않았습니다. 리뷰어를 지정하거나 작성자에게 확인하세요.`,
      kind: "issue",
      metric: "PR 미갱신",
      items: issuePrStale.sort(desc),
    },
    {
      id: "pr-long-open",
      title: "너무 오래 열려 있는 PR",
      hint: `${longOpenDays}일 이상 병합되지 않았습니다. lgtm/approved 여부를 확인하고 머지하거나 닫으세요.`,
      kind: "pr",
      metric: "오픈 경과",
      items: prLongOpen.sort(desc),
    },
    {
      id: "issue-no-pr",
      title: "PR이 없는 Issue",
      hint: `${noPrDays}일 이상 아무도 잡지 않았습니다. 주간 미팅에서 자원자를 배정하세요.`,
      kind: "issue",
      metric: "생성 경과",
      items: issueNoPr.sort(desc),
    },
  ];
}

// ---------------------------------------------------------------------------
// 스냅샷 & 추이 (append-only, git 히스토리를 시계열 저장소로 사용)
// ---------------------------------------------------------------------------

/** ISO 8601 주차: 목요일 기준. 같은 주 재실행은 같은 파일에 덮어써 멱등성 유지. */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // 목요일로 이동 (ISO 주는 목요일이 속한 해/주에 귀속)
  const dayNum = (d.getUTCDay() + 6) % 7; // 월=0 … 일=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** report 에서 추이용 집계만 추출 (수십 바이트) */
function summarize(report, week) {
  const bySec = Object.fromEntries(report.sections.map((s) => [s.id, s.items.length]));
  return {
    week,
    generatedAt: report.generatedAt,
    openIssues: report.totals.openIssues,
    openPrs: report.totals.openPrs,
    issuePrClosed: bySec["issue-pr-closed"] ?? 0,
    issuePrStale: bySec["issue-pr-stale"] ?? 0,
    prLongOpen: bySec["pr-long-open"] ?? 0,
    issueNoPr: bySec["issue-no-pr"] ?? 0,
  };
}

/** 원본 스냅샷 저장 + keepWeeks 초과분 삭제(롤링). 집계는 건드리지 않는다. */
async function writeSnapshot(report, week) {
  await mkdir(CONFIG.snapshotDir, { recursive: true });
  const file = join(CONFIG.snapshotDir, `${week}.json`);
  await writeFile(file, JSON.stringify(report) + "\n", "utf8"); // 원본은 압축(비-pretty)

  // 롤링: 파일명(주차) 역순 정렬 후 keepWeeks 개만 남기고 삭제
  const files = (await readdir(CONFIG.snapshotDir))
    .filter((f) => /^\d{4}-W\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  const stale = files.slice(CONFIG.keepWeeks);
  for (const f of stale) await rm(join(CONFIG.snapshotDir, f));
  return { file, pruned: stale.length };
}

/** 추이 파일에 이번 주 집계를 upsert (같은 주 재실행 시 교체). 오래된 항목도 유지 = 영구 보관. */
async function upsertTrend(summary) {
  let trend = [];
  try {
    trend = JSON.parse(await readFile(CONFIG.trendOut, "utf8"));
    if (!Array.isArray(trend)) trend = [];
  } catch {
    /* 최초 실행: 파일 없음 */
  }
  const i = trend.findIndex((t) => t.week === summary.week);
  if (i >= 0) trend[i] = summary;
  else trend.push(summary);
  trend.sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));

  await mkdir(dirname(CONFIG.trendOut), { recursive: true });
  await writeFile(CONFIG.trendOut, JSON.stringify(trend, null, 2) + "\n", "utf8");
  return trend.length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const base = `repo:${CONFIG.repo} label:"${CONFIG.label}" is:open`;

  console.log(`▸ ${CONFIG.repo} / ${CONFIG.label}`);

  console.log("▸ Issue 수집 중...");
  const rawIssues = await searchAll(ISSUE_QUERY, `${base} is:issue`);
  const issues = rawIssues.map(normalizeIssue);
  console.log(`  ${issues.length}건`);

  console.log("▸ PR 수집 중...");
  const rawPrs = await searchAll(PULL_QUERY, `${base} is:pr`);
  const prs = rawPrs.map(normalizePr);
  console.log(`  ${prs.length}건`);

  const sections = classify(issues, prs);

  const report = {
    generatedAt: new Date().toISOString(),
    repo: CONFIG.repo,
    label: CONFIG.label,
    thresholds: {
      staleDays: CONFIG.staleDays,
      longOpenDays: CONFIG.longOpenDays,
      noPrDays: CONFIG.noPrDays,
    },
    totals: { openIssues: issues.length, openPrs: prs.length },
    sections,
  };

  await mkdir(dirname(CONFIG.out), { recursive: true });
  await writeFile(CONFIG.out, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(`\n▸ ${CONFIG.out} 생성 완료`);
  for (const s of sections) console.log(`  ${String(s.items.length).padStart(3)}  ${s.title}`);

  // ── 스냅샷 + 추이 ──────────────────────────────────────────────────────
  const week = isoWeek(new Date());
  const summary = summarize(report, week);
  const snap = await writeSnapshot(report, week);
  const trendLen = await upsertTrend(summary);

  console.log(`\n▸ 스냅샷 ${week} 저장 (원본 ${snap.pruned}개 롤링 삭제)`);
  console.log(`▸ 추이 ${trendLen}주치 누적 → ${CONFIG.trendOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
