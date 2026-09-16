export const OWNER = "OogaBoogaX";
export const REPO = "entropylab";
export const BRANCH = "rock";
export const REPO_FULL = `${OWNER}/${REPO}`;
export const SCHEMA_VERSION = 1;

// Incremental commit sync re-reads this many days before the watermark:
// rebases and cherry-picks can introduce commits whose committedDate predates
// the newest one already seen, and upserts are idempotent so overlap is free.
export const COMMIT_OVERLAP_DAYS = 7;

// A sync_runs row stuck in 'running' longer than this is presumed crashed.
export const STALE_RUN_MINUTES = 30;
