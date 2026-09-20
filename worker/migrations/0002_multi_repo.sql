-- Multi-repo: every event, rollup and sync cursor gains a repo dimension
-- (short name; OWNER stays a single constant in config). Comments are dropped
-- from the product entirely, so comment events are not carried over and the
-- CHECK constraint no longer admits them.

-- activity_events: the inline UNIQUE(external_id) from 0001 owns an automatic
-- index that cannot be dropped, so the table is rebuilt. The DEFAULT keeps
-- old-code writes valid during the migration->deploy window.
CREATE TABLE activity_events_new (
  id             INTEGER PRIMARY KEY,
  repo           TEXT NOT NULL DEFAULT 'entropylab',
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  type           TEXT NOT NULL CHECK (type IN ('commit','pr','review')),
  external_id    TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  payload        TEXT,
  UNIQUE (repo, external_id)
);
INSERT INTO activity_events_new (id, repo, contributor_id, type, external_id, occurred_at, payload)
  SELECT id, 'entropylab', contributor_id, type, external_id, occurred_at, payload
  FROM activity_events
  WHERE type IN ('commit','pr','review');
DROP TABLE activity_events;
ALTER TABLE activity_events_new RENAME TO activity_events;
CREATE INDEX idx_events_contributor_time ON activity_events(contributor_id, occurred_at);
CREATE INDEX idx_events_type_time        ON activity_events(type, occurred_at);
CREATE INDEX idx_events_repo_time        ON activity_events(repo, occurred_at);

-- daily_rollups is recomputed in full after every event-writing sync, so it
-- is rebuilt and repopulated immediately: /v1/stats stays non-empty between
-- this migration and the next sync.
DROP TABLE daily_rollups;
CREATE TABLE daily_rollups (
  repo           TEXT NOT NULL DEFAULT 'entropylab',
  day            TEXT NOT NULL,
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  type           TEXT NOT NULL,
  count          INTEGER NOT NULL,
  PRIMARY KEY (repo, day, contributor_id, type)
);
INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
  SELECT repo, substr(occurred_at, 1, 10), contributor_id, type, COUNT(*)
  FROM activity_events
  GROUP BY 1, 2, 3, 4;

-- sync_state: per-repo per-source cursors. entropylab keeps its commits/prs
-- watermarks (stays incremental, no re-backfill); comment cursors are dropped
-- with the sources. The 'rotation' fairness pointer lives here too, under
-- repo='*'.
CREATE TABLE sync_state_new (
  repo       TEXT NOT NULL,
  source     TEXT NOT NULL,
  cursor     TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, source)
);
INSERT INTO sync_state_new (repo, source, cursor, updated_at)
  SELECT 'entropylab', source, cursor, updated_at
  FROM sync_state
  WHERE source IN ('commits', 'prs');
DROP TABLE sync_state;
ALTER TABLE sync_state_new RENAME TO sync_state;

-- Discovered org repos: the discovery cache and each repo's default branch.
-- is_active = 0 marks archived/excluded/vanished repos, which stop syncing
-- but keep their history.
CREATE TABLE repos (
  name            TEXT PRIMARY KEY,
  default_branch  TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  discovered_at   TEXT NOT NULL,
  last_checked_at TEXT NOT NULL
);
