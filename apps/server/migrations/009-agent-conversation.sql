-- M2 agent loop. The task log gains three metadata-only event types (user_message, assistant_turn, tool_call); SQLite
-- cannot alter a CHECK constraint, so task_events is rebuilt with identical columns, its rows copied unchanged and its
-- index and append-only triggers recreated. 004 stays as applied (migrations are checksummed and never edited).
CREATE TABLE task_events_next (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL CHECK(seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('task_created', 'task_state_changed', 'tool_output_summary', 'user_message', 'assistant_turn', 'tool_call')),
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

-- The conversation text a person sees: the prompt they wrote and the model's answer for each turn. It is product data,
-- kept apart from the event log so the log stays small and metadata-only. Tool results (file contents) are never
-- stored here or anywhere else. Rows are append-only, like the events that reference them.
CREATE TABLE task_messages (
  id TEXT PRIMARY KEY NOT NULL CHECK(oa_utf16_length(id) = 36),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  turn INTEGER NOT NULL CHECK(turn >= 0),
  text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) <= 524288),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX task_messages_task ON task_messages(task_id, created_at, id);
CREATE TRIGGER task_messages_no_update BEFORE UPDATE ON task_messages
  BEGIN SELECT RAISE(ABORT, 'TASK_MESSAGES_APPEND_ONLY'); END;
CREATE TRIGGER task_messages_no_delete BEFORE DELETE ON task_messages
  BEGIN SELECT RAISE(ABORT, 'TASK_MESSAGES_APPEND_ONLY'); END;
