ALTER TABLE tasks ADD COLUMN session_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN previous_task_id TEXT REFERENCES tasks(id);

CREATE UNIQUE INDEX task_session_next ON tasks(previous_task_id) WHERE previous_task_id IS NOT NULL;
CREATE INDEX task_session_history ON tasks(session_id);

CREATE TABLE task_checkpoints (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  checkpoint TEXT NOT NULL CHECK(json_valid(checkpoint) AND length(CAST(checkpoint AS BLOB)) <= 65536)
) STRICT;
