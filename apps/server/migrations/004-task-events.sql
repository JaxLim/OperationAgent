-- P2.1 task log owned by Express (ARCHITECTURE §7). A task's state and its event commit in one transaction;
-- events are append-only with a gap-free per-task seq from 1. No prompts, output deltas or secrets are stored.
-- project_id has no foreign key: a task's audit trail outlives a project the user later forgets.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED',
    'STOPPING', 'STOPPED', 'INTERRUPTED')),
  last_seq INTEGER NOT NULL CHECK(last_seq >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE task_events (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL CHECK(seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('task_created', 'task_state_changed', 'tool_output_summary')),
  request_id TEXT,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 32768),
  PRIMARY KEY (task_id, seq)
) STRICT;
-- A retried request is applied once; recovery events carry no request id.
CREATE UNIQUE INDEX task_events_request ON task_events(request_id) WHERE request_id IS NOT NULL;
CREATE TRIGGER task_events_gap_free BEFORE INSERT ON task_events
  WHEN NEW.seq != (SELECT coalesce(max(seq), 0) + 1 FROM task_events WHERE task_id = NEW.task_id)
  BEGIN SELECT RAISE(ABORT, 'TASK_EVENT_SEQUENCE_GAP'); END;
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
  BEGIN SELECT RAISE(ABORT, 'TASK_EVENTS_APPEND_ONLY'); END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
  BEGIN SELECT RAISE(ABORT, 'TASK_EVENTS_APPEND_ONLY'); END;
