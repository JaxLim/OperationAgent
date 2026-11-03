import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { AGENT_LIMITS, AgentSaveSchema, AgentSchema, BUILT_IN_AGENTS, CredentialHintSchema, CredentialStatusSchema, LinkedProviderSchema, MCP_LIMITS,
  McpServerSaveSchema, McpServerSchema, MODEL_LIMITS, ModelIdSchema } from '@operation-agent/contracts';
import type { Agent, AgentSave, CredentialSlot, CredentialStatus, LinkedProvider, McpServer, McpServerSave } from '@operation-agent/contracts';
import { CREDENTIAL_SCHEME } from './models.js';
import type { CredentialStore } from './models.js';

// Settings expansion (migration 006). Credentials follow the same rule as 005: ciphertext and a hint only, written
// after CredentialService has encrypted through the Main bridge. Agent and MCP definitions are inert configuration.

export interface ConfigStore {
  credentialStore(slot: CredentialSlot): CredentialStore;
  getProviderModel(provider: LinkedProvider): string | null;
  saveProviderModel(provider: LinkedProvider, model: string): string | null;
  listAgents(): Agent[];
  /** Throws RECORD_CONFLICT for a reserved or taken name, NOT_FOUND for an unknown id, LIMIT_EXCEEDED past the bounds. */
  saveAgent(input: AgentSave): Agent[];
  removeAgent(id: string): boolean;
  listMcpServers(): McpServer[];
  saveMcpServer(input: McpServerSave): McpServer[];
  removeMcpServer(id: string): boolean;
}

type Table = 'agents' | 'mcp_servers';
interface Row { id: string; value: string; createdAt: string; updatedAt: string }

export function createConfigStore(db: Database.Database): ConfigStore {
  const credentialStore = (slot: CredentialSlot): CredentialStore => {
    const read = db.prepare<[string], { ciphertext: string; hint: string | null; updatedAt: string; scheme: string }>(
      'SELECT ciphertext, hint, updated_at AS updatedAt, scheme FROM provider_credentials WHERE slot = ?');
    const status = (): CredentialStatus => {
      const row = read.get(slot);
      if (!row || row.scheme !== CREDENTIAL_SCHEME) return { configured: false };
      return CredentialStatusSchema.parse({ configured: true, hint: CredentialHintSchema.safeParse(row.hint).success ? row.hint : null, updatedAt: row.updatedAt });
    };
    return {
      credentialStatus: status,
      saveCredential(ciphertext, hint) {
        if (ciphertext.length < 4 || ciphertext.length > MODEL_LIMITS.maxCiphertextChars) throw new Error('VALIDATION_ERROR');
        const safeHint = hint !== null && CredentialHintSchema.safeParse(hint).success ? hint : null;
        return db.transaction(() => {
          db.prepare(`INSERT INTO provider_credentials(slot, scheme, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(slot) DO UPDATE SET scheme = excluded.scheme, ciphertext = excluded.ciphertext, hint = excluded.hint,
            updated_at = excluded.updated_at`).run(slot, CREDENTIAL_SCHEME, ciphertext, safeHint, new Date().toISOString());
          return status();
        }).immediate();
      },
      readCiphertext() {
        const row = read.get(slot);
        return row && row.scheme === CREDENTIAL_SCHEME ? row.ciphertext : null;
      },
      clearCredential() {
        db.prepare('DELETE FROM provider_credentials WHERE slot = ?').run(slot);
        return status();
      },
    };
  };
  const readModel = db.prepare<[string], { model: string }>('SELECT model FROM provider_models WHERE provider = ?');
  const getProviderModel = (provider: LinkedProvider): string | null => {
    const parsed = ModelIdSchema.safeParse(readModel.get(LinkedProviderSchema.parse(provider))?.model);
    return parsed.success ? parsed.data : null;
  };

  const rows = (table: Table): Row[] => db.prepare<[], Row>(
    `SELECT id, value, created_at AS createdAt, updated_at AS updatedAt FROM ${table} ORDER BY created_at, id`).all();
  const parseRows = <T>(table: Table, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T[] =>
    rows(table).flatMap(row => {
      let value: unknown;
      try { value = JSON.parse(row.value); } catch { return []; }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
      const parsed = schema.safeParse({ ...value, id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt });
      return parsed.success ? [parsed.data] : [];
    });
  const listAgents = (): Agent[] => parseRows('agents', AgentSchema);
  const listMcpServers = (): McpServer[] => parseRows('mcp_servers', McpServerSchema);
  /** Inserts or replaces one definition and re-checks the bounds of the whole list inside the same transaction. */
  const save = <T>(table: Table, id: string | undefined, name: string, value: object, max: number, maxBytes: number, list: () => T[]): T[] =>
    db.transaction(() => {
      const now = new Date().toISOString();
      if (id) {
        if (db.prepare(`UPDATE ${table} SET name = ?, value = ?, updated_at = ? WHERE id = ?`).run(name, JSON.stringify(value), now, id).changes !== 1) throw new Error('NOT_FOUND');
      } else {
        if ((db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total >= max) throw new Error('LIMIT_EXCEEDED');
        db.prepare(`INSERT INTO ${table}(id, name, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), name, JSON.stringify(value), now, now);
      }
      const result = list();
      // Whole lists travel in one bounded reply; a save that would not fit is rolled back.
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error('LIMIT_EXCEEDED');
      return result;
    }).immediate();
  const reserved = new Set(BUILT_IN_AGENTS.map(agent => agent.name));

  return {
    credentialStore,
    getProviderModel,
    saveProviderModel(provider, model) {
      const value = ModelIdSchema.parse(model);
      db.prepare(`INSERT INTO provider_models(provider, model, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`).run(LinkedProviderSchema.parse(provider), value, new Date().toISOString());
      return getProviderModel(provider);
    },
    listAgents,
    saveAgent(input) {
      const { id, ...value } = AgentSaveSchema.parse(input);
      if (reserved.has(value.name)) throw new Error('RECORD_CONFLICT');
      return save('agents', id, value.name, value, AGENT_LIMITS.maxAgents, AGENT_LIMITS.maxListBytes, listAgents);
    },
    removeAgent: id => db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes === 1,
    listMcpServers,
    saveMcpServer(input) {
      const { id, ...value } = McpServerSaveSchema.parse(input);
      return save('mcp_servers', id, value.name, value, MCP_LIMITS.maxServers, MCP_LIMITS.maxListBytes, listMcpServers);
    },
    removeMcpServer: id => db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes === 1,
  };
}
