import { OWNER, REPO } from "../config";
import { syncStateUpsert } from "../db/queries";
import { githubGraphQL } from "./github";
import { maxIso, persistPage, type SyncContext } from "./context";
import {
  actorFrom,
  type GqlActor,
  type PageInfo,
  type ParsedEvent,
} from "./types";

const ACTOR = `author { login avatarUrl __typename ... on User { databaseId } ... on Bot { databaseId } }`;

// ---------------------------------------------------------------------------
// Issue comments. GraphQL has no repository-level issueComments connection
// (verified against the live schema), so comments are harvested by walking
// issues; a new comment bumps its issue's updatedAt, which is what makes the
// incremental UPDATED_AT DESC walk complete. PR-conversation comments come
// from the PR walker, not here.
// ---------------------------------------------------------------------------

export type IssuesState =
  | { phase: "backfill"; cursor: string | null; maxSeen: string | null }
  | { phase: "incremental"; updatedSince: string };

const ISSUES_QUERY = `
query Issues($owner: String!, $name: String!, $cursor: String, $order: IssueOrderField!, $dir: OrderDirection!) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $cursor, orderBy: { field: $order, direction: $dir }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number updatedAt
        comments(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { id createdAt ${ACTOR} }
        }
      }
    }
  }
  rateLimit { remaining resetAt }
}`;

const ISSUE_OVERFLOW_QUERY = `
query IssueOverflow($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on Issue {
      number
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id createdAt ${ACTOR} }
      }
    }
  }
  rateLimit { remaining resetAt }
}`;

interface GqlComment {
  id: string;
  createdAt: string;
  author: GqlActor | null;
}

interface GqlIssue {
  id: string;
  number: number;
  updatedAt: string;
  comments: { pageInfo: PageInfo; nodes: GqlComment[] };
}

function issueCommentEvents(
  comments: GqlComment[],
  issueNumber: number,
): ParsedEvent[] {
  return comments.map((c) => ({
    type: "comment_issue" as const,
    externalId: c.id,
    occurredAt: c.createdAt,
    actor: actorFrom(c.author),
    payload: { issueNumber, surface: "issue" },
  }));
}

export function parseIssuesPage(data: Record<string, unknown>): {
  issues: GqlIssue[];
  pageInfo: PageInfo;
} {
  const conn = (data as any).repository?.issues;
  if (!conn)
    return { issues: [], pageInfo: { hasNextPage: false, endCursor: null } };
  return {
    issues: (conn.nodes as Array<GqlIssue | null>).filter(
      (n): n is GqlIssue => n !== null,
    ),
    pageInfo: conn.pageInfo as PageInfo,
  };
}

async function drainIssueOverflow(
  ctx: SyncContext,
  issue: GqlIssue,
  events: ParsedEvent[],
): Promise<boolean> {
  let cursor = issue.comments.pageInfo.endCursor;
  let hasNext = issue.comments.pageInfo.hasNextPage;
  while (hasNext) {
    if (!ctx.budget.canAfford(2)) return false;
    const { data } = await githubGraphQL(
      ctx.env,
      ctx.budget,
      ISSUE_OVERFLOW_QUERY,
      {
        id: issue.id,
        cursor,
      },
    );
    const node = (data as any).node as GqlIssue | null;
    if (!node) return true;
    events.push(...issueCommentEvents(node.comments.nodes, issue.number));
    hasNext = node.comments.pageInfo.hasNextPage;
    cursor = node.comments.pageInfo.endCursor;
  }
  return true;
}

export async function syncIssueComments(
  ctx: SyncContext,
  state: IssuesState | null,
): Promise<boolean> {
  let s: IssuesState = state ?? {
    phase: "backfill",
    cursor: null,
    maxSeen: null,
  };

  if (s.phase === "backfill") {
    while (ctx.budget.canAfford(3)) {
      const { data } = await githubGraphQL(ctx.env, ctx.budget, ISSUES_QUERY, {
        owner: OWNER,
        name: REPO,
        cursor: s.cursor,
        order: "CREATED_AT",
        dir: "ASC",
      });
      const { issues, pageInfo } = parseIssuesPage(data);
      const events: ParsedEvent[] = [];
      let pageMax: string | null = s.maxSeen;
      for (const issue of issues) {
        events.push(...issueCommentEvents(issue.comments.nodes, issue.number));
        if (!(await drainIssueOverflow(ctx, issue, events))) return false;
        pageMax = maxIso(pageMax, issue.updatedAt);
      }
      if (pageInfo.hasNextPage) {
        s = { phase: "backfill", cursor: pageInfo.endCursor, maxSeen: pageMax };
        await persistPage(ctx, "issue_comments", events, s);
      } else {
        s = {
          phase: "incremental",
          updatedSince: pageMax ?? new Date(0).toISOString(),
        };
        await persistPage(ctx, "issue_comments", events, s);
        return true;
      }
    }
    return false;
  }

  let cursor: string | null = null;
  let newWatermark = s.updatedSince;
  for (;;) {
    if (!ctx.budget.canAfford(3)) return false;
    const { data } = await githubGraphQL(ctx.env, ctx.budget, ISSUES_QUERY, {
      owner: OWNER,
      name: REPO,
      cursor,
      order: "UPDATED_AT",
      dir: "DESC",
    });
    const { issues, pageInfo } = parseIssuesPage(data);
    const events: ParsedEvent[] = [];
    let sawOlder = false;
    for (const issue of issues) {
      if (issue.updatedAt < s.updatedSince) {
        sawOlder = true;
        break;
      }
      events.push(...issueCommentEvents(issue.comments.nodes, issue.number));
      if (!(await drainIssueOverflow(ctx, issue, events))) return false;
      newWatermark = maxIso(newWatermark, issue.updatedAt)!;
    }
    const done = sawOlder || !pageInfo.hasNextPage;
    await persistPage(ctx, "issue_comments", events, {
      phase: "incremental",
      updatedSince: done ? newWatermark : s.updatedSince,
    });
    if (done) return true;
    cursor = pageInfo.endCursor;
  }
}

// ---------------------------------------------------------------------------
// Commit comments. repository.commitComments has no orderBy/since filters
// (verified) and is append-ordered, so both backfill and incremental use a
// permanent cursor-resume: always continue from the stored endCursor. If a
// deletion ever invalidates the cursor, reset to null and re-walk — the whole
// surface is a page or two here, and upserts are idempotent.
// Attribution: the commenter (the comment's author), not the commit's author.
// ---------------------------------------------------------------------------

export interface CommitCommentsState {
  cursor: string | null;
}

const COMMIT_COMMENTS_QUERY = `
query CommitComments($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    commitComments(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id createdAt commit { oid } ${ACTOR} }
    }
  }
  rateLimit { remaining resetAt }
}`;

interface GqlCommitComment {
  id: string;
  createdAt: string;
  commit: { oid: string } | null;
  author: GqlActor | null;
}

export function parseCommitCommentsPage(data: Record<string, unknown>): {
  events: ParsedEvent[];
  pageInfo: PageInfo;
} {
  const conn = (data as any).repository?.commitComments;
  if (!conn)
    return { events: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const events = (conn.nodes as Array<GqlCommitComment | null>)
    .filter((c): c is GqlCommitComment => c !== null)
    .map((c) => ({
      type: "comment_commit" as const,
      externalId: c.id,
      occurredAt: c.createdAt,
      actor: actorFrom(c.author),
      payload: { commitOid: c.commit?.oid ?? null },
    }));
  return { events, pageInfo: conn.pageInfo as PageInfo };
}

export async function syncCommitComments(
  ctx: SyncContext,
  state: CommitCommentsState | null,
): Promise<boolean> {
  let cursor = state?.cursor ?? null;
  while (ctx.budget.canAfford(3)) {
    let data: Record<string, unknown>;
    try {
      ({ data } = await githubGraphQL(
        ctx.env,
        ctx.budget,
        COMMIT_COMMENTS_QUERY,
        {
          owner: OWNER,
          name: REPO,
          cursor,
        },
      ));
    } catch (e) {
      // An invalidated cursor (deleted comment) surfaces as a GraphQL error;
      // reset and re-walk from the start next invocation.
      if (
        cursor !== null &&
        !(e instanceof Error && e.name === "RateLimited")
      ) {
        ctx.budget.spend();
        await ctx.db.batch([
          syncStateUpsert(ctx.db, "commit_comments", { cursor: null }),
        ]);
        return false;
      }
      throw e;
    }
    const { events, pageInfo } = parseCommitCommentsPage(data);
    // Keep the cursor pointing at the last item we have seen; querying after
    // it later returns only newer comments.
    const newCursor = pageInfo.endCursor ?? cursor;
    await persistPage(ctx, "commit_comments", events, { cursor: newCursor });
    if (!pageInfo.hasNextPage) return true;
    cursor = pageInfo.endCursor;
  }
  return false;
}
