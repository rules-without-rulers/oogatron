-- Comments return as contributions and PR merges become their own event
-- type. SQLite cannot alter a CHECK constraint, so activity_events is
-- rebuilt once more with the widened type list; every existing row copies
-- over unchanged.
CREATE TABLE activity_events_new (
  id             INTEGER PRIMARY KEY,
  repo           TEXT NOT NULL DEFAULT 'entropylab',
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  type           TEXT NOT NULL CHECK (type IN
                   ('commit','pr','review','merge','comment_issue','comment_review','comment_commit')),
  external_id    TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  payload        TEXT,
  UNIQUE (repo, external_id)
);
INSERT INTO activity_events_new (id, repo, contributor_id, type, external_id, occurred_at, payload)
  SELECT id, repo, contributor_id, type, external_id, occurred_at, payload
  FROM activity_events;
DROP TABLE activity_events;
ALTER TABLE activity_events_new RENAME TO activity_events;
CREATE INDEX idx_events_contributor_time ON activity_events(contributor_id, occurred_at);
CREATE INDEX idx_events_type_time        ON activity_events(type, occurred_at);
CREATE INDEX idx_events_repo_time        ON activity_events(repo, occurred_at);

-- Force a full PR re-walk on every repo: merge events for already-merged PRs
-- (and PR-thread comments on old PRs) sit behind the incremental updatedAt
-- watermark and would otherwise never be ingested. Upserts are idempotent,
-- so the re-walk only adds the new event types.
DELETE FROM sync_state WHERE source = 'prs';
