import { OWNER } from "../config";
import { githubGraphQL } from "./github";
import { maxIso, persistPage, type SyncContext } from "./context";
import {
  actorFrom,
  type GqlActor,
  type PageInfo,
  type ParsedEvent,
  type RepoRef,
} from "./types";

export type PrsState =
  | { phase: "backfill"; cursor: string | null; maxSeen: string | null }
  | { phase: "incremental"; updatedSince: string };

const ACTOR = `author { login avatarUrl __typename ... on User { databaseId } ... on Bot { databaseId } }`;
const REVIEW = `id state body submittedAt ${ACTOR}`;
const PR = `
  id number title state createdAt updatedAt mergedAt additions deletions
  ${ACTOR}
  reviews(first: 50) { pageInfo { hasNextPage endCursor } nodes { ${REVIEW} } }`;

const PAGE_QUERY = `
query PRs($owner: String!, $name: String!, $cursor: String, $order: IssueOrderField!, $dir: OrderDirection!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 25, after: $cursor, orderBy: { field: $order, direction: $dir }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR} }
    }
  }
  rateLimit { remaining resetAt }
}`;

const PR_OVERFLOW_QUERY = `
query PrOverflow($id: ID!, $reviewCursor: String) {
  node(id: $id) {
    ... on PullRequest {
      number
      reviews(first: 50, after: $reviewCursor) { pageInfo { hasNextPage endCursor } nodes { ${REVIEW} } }
    }
  }
  rateLimit { remaining resetAt }
}`;

interface GqlReview {
  id: string;
  state: string;
  body: string;
  submittedAt: string | null;
  author: GqlActor | null;
}

interface GqlPr {
  id: string;
  number: number;
  title: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  author: GqlActor | null;
  reviews: { pageInfo: PageInfo; nodes: GqlReview[] };
}

export interface FollowUp {
  kind: "pr_overflow";
  nodeId: string;
  prNumber: number;
  reviewCursor: string | null;
}

// GitHub auto-creates an empty-body COMMENTED "container" review for every
// batch of line comments; counting those would turn each line-comment burst
// into a phantom review. PENDING reviews are unsubmitted drafts. A review
// event therefore requires a real submission: an explicit verdict, or a
// COMMENTED review whose body carries actual prose.
export function isCountableReview(state: string, body: string): boolean {
  if (state === "APPROVED" || state === "CHANGES_REQUESTED") return true;
  if (state === "DISMISSED") return true;
  return state === "COMMENTED" && body.trim().length > 0;
}

function reviewEvents(
  review: GqlReview,
  prNumber: number,
  out: ParsedEvent[],
): void {
  if (review.state === "PENDING") {
    // Unsubmitted draft, only visible to its author; it surfaces later once
    // the review is submitted.
    return;
  }
  if (isCountableReview(review.state, review.body)) {
    out.push({
      type: "review",
      externalId: review.id,
      occurredAt: review.submittedAt ?? "",
      actor: actorFrom(review.author),
      payload: {
        state: review.state,
        prNumber,
        hasBody: review.body.trim().length > 0,
      },
    });
  }
}

export function parsePrNode(pr: GqlPr): {
  events: ParsedEvent[];
  followUps: FollowUp[];
} {
  const events: ParsedEvent[] = [];
  const followUps: FollowUp[] = [];

  events.push({
    type: "pr",
    externalId: pr.id,
    occurredAt: pr.createdAt,
    actor: actorFrom(pr.author),
    payload: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
    },
  });

  for (const review of pr.reviews.nodes) {
    reviewEvents(review, pr.number, events);
  }

  if (pr.reviews.pageInfo.hasNextPage) {
    followUps.push({
      kind: "pr_overflow",
      nodeId: pr.id,
      prNumber: pr.number,
      reviewCursor: pr.reviews.pageInfo.endCursor,
    });
  }

  return { events, followUps };
}

export function parsePrsPage(data: Record<string, unknown>): {
  prs: GqlPr[];
  pageInfo: PageInfo;
} {
  const conn = (data as any).repository?.pullRequests;
  if (!conn)
    return { prs: [], pageInfo: { hasNextPage: false, endCursor: null } };
  // Null slots are nodes GitHub failed to resolve (partial responses).
  const prs = (conn.nodes as Array<GqlPr | null>).filter(
    (n): n is GqlPr => n !== null,
  );
  return { prs, pageInfo: conn.pageInfo as PageInfo };
}

// Drains review-overflow fetches for one page of PRs. Returns false if the
// budget ran out first (the caller then abandons the page without persisting,
// so the next invocation redoes it — idempotent upserts make that free).
async function drainFollowUps(
  ctx: SyncContext,
  followUps: FollowUp[],
  events: ParsedEvent[],
): Promise<boolean> {
  while (followUps.length > 0) {
    if (!ctx.budget.canAfford(2)) return false;
    const f = followUps.pop()!;
    const { data } = await githubGraphQL(
      ctx.env,
      ctx.budget,
      PR_OVERFLOW_QUERY,
      {
        id: f.nodeId,
        reviewCursor: f.reviewCursor,
      },
    );
    const node = (data as any).node as GqlPr | null;
    if (!node) continue;
    for (const review of node.reviews.nodes) {
      reviewEvents(review, f.prNumber, events);
    }
    if (node.reviews.pageInfo.hasNextPage) {
      followUps.push({ ...f, reviewCursor: node.reviews.pageInfo.endCursor });
    }
  }
  return true;
}

export async function syncPrs(
  ctx: SyncContext,
  repo: RepoRef,
  state: PrsState | null,
): Promise<boolean> {
  let s: PrsState = state ?? { phase: "backfill", cursor: null, maxSeen: null };

  if (s.phase === "backfill") {
    // CREATED_AT ASC: createdAt is immutable, so the resume cursor stays
    // stable across invocations even while the repo moves.
    while (ctx.budget.canAfford(3)) {
      const { data } = await githubGraphQL(ctx.env, ctx.budget, PAGE_QUERY, {
        owner: OWNER,
        name: repo.name,
        cursor: s.cursor,
        order: "CREATED_AT",
        dir: "ASC",
      });
      const { prs, pageInfo } = parsePrsPage(data);
      const events: ParsedEvent[] = [];
      const followUps: FollowUp[] = [];
      let pageMax: string | null = s.maxSeen;
      for (const pr of prs) {
        const parsed = parsePrNode(pr);
        events.push(...parsed.events);
        followUps.push(...parsed.followUps);
        pageMax = maxIso(pageMax, pr.updatedAt);
      }
      if (!(await drainFollowUps(ctx, followUps, events))) return false;
      if (pageInfo.hasNextPage) {
        s = { phase: "backfill", cursor: pageInfo.endCursor, maxSeen: pageMax };
        await persistPage(ctx, repo.name, "prs", events, s);
      } else {
        s = {
          phase: "incremental",
          updatedSince: pageMax ?? new Date(0).toISOString(),
        };
        await persistPage(ctx, repo.name, "prs", events, s);
        return true;
      }
    }
    return false;
  }

  // Incremental: UPDATED_AT DESC, stop at the watermark. Re-upserting a whole
  // PR node catches new reviews on old PRs, since a review bumps the PR's
  // updatedAt.
  let cursor: string | null = null;
  let newWatermark = s.updatedSince;
  for (;;) {
    if (!ctx.budget.canAfford(3)) return false;
    const { data } = await githubGraphQL(ctx.env, ctx.budget, PAGE_QUERY, {
      owner: OWNER,
      name: repo.name,
      cursor,
      order: "UPDATED_AT",
      dir: "DESC",
    });
    const { prs, pageInfo } = parsePrsPage(data);
    const events: ParsedEvent[] = [];
    const followUps: FollowUp[] = [];
    let sawOlder = false;
    for (const pr of prs) {
      if (pr.updatedAt < s.updatedSince) {
        sawOlder = true;
        break;
      }
      const parsed = parsePrNode(pr);
      events.push(...parsed.events);
      followUps.push(...parsed.followUps);
      newWatermark = maxIso(newWatermark, pr.updatedAt)!;
    }
    if (!(await drainFollowUps(ctx, followUps, events))) return false;
    const done = sawOlder || !pageInfo.hasNextPage;
    await persistPage(ctx, repo.name, "prs", events, {
      phase: "incremental",
      updatedSince: done ? newWatermark : s.updatedSince,
    });
    if (done) return true;
    cursor = pageInfo.endCursor;
  }
}
