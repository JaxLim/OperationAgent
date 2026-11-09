import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { TOOL_AUDIT_LIMITS, ToolAuditEntrySchema, ToolAuditInputSchema } from '@operation-agent/contracts';
import type { ToolAuditEntry, ToolAuditInput } from '@operation-agent/contracts';

// Migration 007: Express's record of every tool decision (SEC-08 "all out-of-bounds reads are refused and audited").
// Rows hold the decision and a normalized relative path, never file content or the workspace root. The table is
// bounded: past the cap the oldest rows are dropped in the same transaction as the insert.

export interface AuditStore {
  recordToolAudit(entry: ToolAuditInput): ToolAuditEntry;
  /** Newest first. */
  listToolAudit(limit?: number): ToolAuditEntry[];
}

interface Row { id: string; toolId: string; projectId: string | null; taskId: string | null; toolCallId: string | null; path: string;
  decision: string; code: string | null; bytes: number; durationMs: number; createdAt: string }

export function createAuditStore(db: Database.Database): AuditStore {
  const insert = db.prepare(`INSERT INTO tool_audit(id, tool_id, project_id, task_id, tool_call_id, path, decision, code, bytes, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const prune = db.prepare(`DELETE FROM tool_audit WHERE id IN (SELECT id FROM tool_audit ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`);
  const select = db.prepare<[number], Row>(`SELECT id, tool_id AS toolId, project_id AS projectId, task_id AS taskId, tool_call_id AS toolCallId,
    path, decision, code, bytes, duration_ms AS durationMs, created_at AS createdAt FROM tool_audit ORDER BY created_at DESC, id DESC LIMIT ?`);
  return {
    recordToolAudit(input) {
      const value = ToolAuditInputSchema.parse(input);
      const entry: ToolAuditEntry = { ...value, id: randomUUID(), createdAt: new Date().toISOString() };
      db.transaction(() => {
        insert.run(entry.id, entry.toolId, entry.projectId, entry.taskId, entry.toolCallId, entry.path, entry.decision, entry.code,
          entry.bytes, entry.durationMs, entry.createdAt);
        prune.run(TOOL_AUDIT_LIMITS.maxRows);
      }).immediate();
      return entry;
    },
    listToolAudit(limit = TOOL_AUDIT_LIMITS.maxList) {
      // Rows are re-validated on the way out; a row that no longer matches the contract is not returned.
      return select.all(Math.max(1, Math.min(limit, TOOL_AUDIT_LIMITS.maxList))).flatMap(row => {
        const parsed = ToolAuditEntrySchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
    },
  };
}
