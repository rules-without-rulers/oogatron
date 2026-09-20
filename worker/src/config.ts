export const OWNER = "OogaBoogaX";
export const SCHEMA_VERSION = 2;

// Repos are discovered from the org (public, non-fork, non-archived); list
// short names here to keep specific repos off the jumbotron anyway.
export const EXCLUDED_REPOS: string[] = [];

// Org repo discovery re-runs when the repos table is older than this; between
// refreshes each sync run reads the cached table only.
export const REPO_DISCOVERY_TTL_MINUTES = 60;

// Incremental commit sync re-reads this many days before the watermark:
// rebases and cherry-picks can introduce commits whose committedDate predates
// the newest one already seen, and upserts are idempotent so overlap is free.
export const COMMIT_OVERLAP_DAYS = 7;

// A sync_runs row stuck in 'running' longer than this is presumed crashed.
export const STALE_RUN_MINUTES = 30;
