CREATE TABLE contributors (
  id            INTEGER PRIMARY KEY,
  github_id     INTEGER UNIQUE,           -- NULL for unmatched commit emails
  login         TEXT NOT NULL UNIQUE,     -- or synthesized "email:<hash>" for unmatched
  display_name  TEXT,
  avatar_url    TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,                     -- ISO 8601
  last_seen_at  TEXT
);

CREATE TABLE activity_events (
  id             INTEGER PRIMARY KEY,
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  type           TEXT NOT NULL CHECK (type IN
                   ('commit','pr','review','comment_issue','comment_review','comment_commit')),
  external_id    TEXT NOT NULL UNIQUE,    -- commit SHA / GraphQL node id -> idempotent upserts
  occurred_at    TEXT NOT NULL,           -- ISO 8601
  payload        TEXT                     -- JSON: title, PR number, additions/deletions, state...
);
CREATE INDEX idx_events_contributor_time ON activity_events(contributor_id, occurred_at);
CREATE INDEX idx_events_type_time        ON activity_events(type, occurred_at);

CREATE TABLE daily_rollups (              -- recomputed after each sync; serves fast queries
  day            TEXT NOT NULL,           -- YYYY-MM-DD
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  type           TEXT NOT NULL,
  count          INTEGER NOT NULL,
  PRIMARY KEY (day, contributor_id, type)
);

CREATE TABLE sync_runs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,              -- 'backfill' | 'incremental'
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | ok | error
  detail      TEXT                        -- error text, cursors, counts
);

CREATE TABLE sync_state (                 -- per-source incremental cursors
  source     TEXT PRIMARY KEY,            -- 'commits' | 'prs' | 'issue_comments' | 'commit_comments'
  cursor     TEXT,                        -- last seen timestamp or GraphQL cursor
  updated_at TEXT NOT NULL
);
