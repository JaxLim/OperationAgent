-- Rebuild the checksummed 009 event table to add plan events, preserving its data and guards.
CREATE TABLE task_events_next (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL CHECK(seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('task_created', 'task_state_changed', 'tool_output_summary', 'user_message', 'assistant_turn', 'tool_call', 'plan_updated', 'plan_stalled')),
  request_id TEXT,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 32768),
  PRIMARY KEY (task_id, seq)
) STRICT;
INSERT INTO task_events_next SELECT task_id, seq, event_id, type, request_id, occurred_at, payload FROM task_events ORDER BY task_id, seq;
DROP TABLE task_events;
ALTER TABLE task_events_next RENAME TO task_events;
CREATE UNIQUE INDEX task_events_request ON task_events(request_id) WHERE request_id IS NOT NULL;
CREATE TRIGGER task_events_gap_free BEFORE INSERT ON task_events
  WHEN NEW.seq != (SELECT coalesce(max(seq), 0) + 1 FROM task_events WHERE task_id = NEW.task_id)
  BEGIN SELECT RAISE(ABORT, 'TASK_EVENT_SEQUENCE_GAP'); END;
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
  BEGIN SELECT RAISE(ABORT, 'TASK_EVENTS_APPEND_ONLY'); END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
  BEGIN SELECT RAISE(ABORT, 'TASK_EVENTS_APPEND_ONLY'); END;

CREATE TABLE task_plans (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  plan TEXT NOT NULL CHECK(json_valid(plan) AND length(CAST(plan AS BLOB)) <= 32768)
) STRICT;

-- No-op calls emit no event but still retain the input and original result for durable idempotency.
CREATE TABLE task_plan_calls (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  turn INTEGER NOT NULL CHECK(turn BETWEEN 1 AND 40),
  call_id TEXT NOT NULL,
  input TEXT NOT NULL CHECK(json_valid(input) AND length(CAST(input AS BLOB)) <= 32768),
  plan TEXT NOT NULL CHECK(json_valid(plan) AND length(CAST(plan AS BLOB)) <= 32768),
  PRIMARY KEY (task_id, turn, call_id)
) STRICT;
CREATE TRIGGER task_plan_calls_no_update BEFORE UPDATE ON task_plan_calls
  BEGIN SELECT RAISE(ABORT, 'TASK_PLAN_CALLS_APPEND_ONLY'); END;
CREATE TRIGGER task_plan_calls_no_delete BEFORE DELETE ON task_plan_calls
  BEGIN SELECT RAISE(ABORT, 'TASK_PLAN_CALLS_APPEND_ONLY'); END;
