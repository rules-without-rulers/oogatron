import { STALE_RUN_MINUTES } from "../config";
import { loadSyncState } from "../db/queries";
import { recomputeRollups } from "../db/rollups";
import { bumpCacheGeneration } from "../api/cache";
import { Budget } from "./budget";
import { reconcileBots } from "./bots";
import { syncCommits, type CommitsState } from "./commits";
import { syncPrs, type PrsState } from "./prs";
import {
  syncCommitComments,
  syncIssueComments,
  type CommitCommentsState,
  type IssuesState,
} from "./comments";
import { ContributorResolver } from "./identity";
import { RateLimited } from "./github";
import type { SyncContext } from "./context";

export interface SyncResult {
  skipped: boolean;
  done: boolean;
  kind: "backfill" | "incremental";
  eventsWritten: number;
  budgetSpent: number;
}

function isBackfilling(state: Map<string, unknown>): boolean {
  const sources = ["commits", "prs", "issue_comments"];
  return sources.some((s) => {
    const v = state.get(s) as { phase?: string } | null | undefined;
    return !v || v.phase === "backfill";
  });
}

export async function runSync(
  env: Env,
  trigger: "cron" | "admin",
): Promise<SyncResult> {
  const db = env.DB;
  const now = new Date().toISOString();
  const staleBefore = new Date(
    Date.now() - STALE_RUN_MINUTES * 60000,
  ).toISOString();

  // Stale-run guard: a row stuck 'running' past the window is presumed
  // crashed; a fresh one means another invocation is active — skip, so cron
  // and admin-driven runs never overlap.
  await db
    .prepare(
      `UPDATE sync_runs SET status = 'error', finished_at = ?,
         detail = COALESCE(detail, '') || ' [marked stale]'
       WHERE status = 'running' AND started_at < ?`,
    )
    .bind(now, staleBefore)
    .run();
  const active = await db
    .prepare("SELECT id FROM sync_runs WHERE status = 'running' LIMIT 1")
    .first();
  if (active) {
    return {
      skipped: true,
      done: false,
      kind: "incremental",
      eventsWritten: 0,
      budgetSpent: 0,
    };
  }

  const state = await loadSyncState(db);
  const kind = isBackfilling(state) ? "backfill" : "incremental";
  const run = await db
    .prepare(
      "INSERT INTO sync_runs (kind, started_at, status) VALUES (?, ?, 'running') RETURNING id",
    )
    .bind(kind, now)
    .first<{ id: number }>();
  const runId = run!.id;

  const ctx: SyncContext = {
    env,
    db,
    budget: new Budget(),
    resolver: await ContributorResolver.load(db),
    eventsWritten: 0,
  };

  let done = false;
  try {
    const commitsDone = await syncCommits(
      ctx,
      state.get("commits") as CommitsState | null,
    );
    const prsDone =
      commitsDone && (await syncPrs(ctx, state.get("prs") as PrsState | null));
    const issuesDone =
      prsDone &&
      (await syncIssueComments(
        ctx,
        state.get("issue_comments") as IssuesState | null,
      ));
    done =
      issuesDone &&
      (await syncCommitComments(
        ctx,
        state.get("commit_comments") as CommitCommentsState | null,
      ));

    if (ctx.eventsWritten > 0) {
      await recomputeRollups(db);
      await reconcileBots(db);
      await bumpCacheGeneration(env);
    }

    await db
      .prepare(
        "UPDATE sync_runs SET status = 'ok', finished_at = ?, detail = ? WHERE id = ?",
      )
      .bind(
        new Date().toISOString(),
        JSON.stringify({
          trigger,
          partial: !done,
          eventsWritten: ctx.eventsWritten,
          budgetSpent: ctx.budget.spent,
        }),
        runId,
      )
      .run();
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // Rate limiting is an expected, graceful stop: cursors for completed
    // pages are already persisted, the next run resumes.
    const status = e instanceof RateLimited ? "ok" : "error";
    await db
      .prepare(
        "UPDATE sync_runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?",
      )
      .bind(
        status,
        new Date().toISOString(),
        JSON.stringify({
          trigger,
          partial: true,
          error: message,
          eventsWritten: ctx.eventsWritten,
          budgetSpent: ctx.budget.spent,
        }),
        runId,
      )
      .run();
    if (status === "error") {
      console.error(
        JSON.stringify({ event: "sync_failed", runId, trigger, message }),
      );
      throw e;
    }
  }

  return {
    skipped: false,
    done,
    kind,
    eventsWritten: ctx.eventsWritten,
    budgetSpent: ctx.budget.spent,
  };
}
