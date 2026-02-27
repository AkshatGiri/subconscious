import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
  ConversationMessage,
  MemoryEdge,
  MemoryNode,
  MemoryStatus,
  SessionState,
  SearchResult,
  MemoryNodeType
} from "../types";

type MemoryRow = {
  id: string;
  type: MemoryNodeType;
  title: string;
  content: string;
  topics_json: string;
  categories_json: string;
  context_json: string;
  strength: number;
  recall_count: number;
  last_accessed: number | null;
  created_at: number;
  updated_at: number;
  created_from: MemoryNode["createdFrom"];
  confidence: number;
  status: MemoryStatus;
  superseded_by: string | null;
  embedding_json: string;
  metadata_json: string;
};

type EdgeRow = {
  id: string;
  from_id: string;
  to_id: string;
  type: MemoryEdge["type"];
  weight: number;
  created_at: number;
  metadata_json: string;
};

type ConversationRow = {
  id: string;
  session_id: string;
  role: ConversationMessage["role"];
  content: string;
  channel: string | null;
  agent: string | null;
  speaker: string | null;
  created_at: number;
  metadata_json: string;
};

type DocumentRow = {
  id: string;
  source_id: string | null;
  title: string | null;
  content: string;
  created_at: number;
  metadata_json: string;
};

const safeParse = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export class SQLiteMemoryStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true, strict: true });
    this.configure();
    this.migrate();
  }

  private configure(): void {
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        channel TEXT,
        agent TEXT,
        speaker TEXT,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_session_created
      ON conversation_entries(session_id, created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts
      USING fts5(entry_id UNINDEXED, content, tokenize='porter');

      CREATE TRIGGER IF NOT EXISTS conversation_ai AFTER INSERT ON conversation_entries BEGIN
        INSERT INTO conversation_fts(entry_id, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS conversation_ad AFTER DELETE ON conversation_entries BEGIN
        DELETE FROM conversation_fts WHERE entry_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS conversation_au AFTER UPDATE ON conversation_entries BEGIN
        DELETE FROM conversation_fts WHERE entry_id = old.id;
        INSERT INTO conversation_fts(entry_id, content) VALUES (new.id, new.content);
      END;

      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        buffer_message_ids_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        source_id TEXT,
        title TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        strength REAL NOT NULL,
        recall_count INTEGER NOT NULL,
        last_accessed INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_from TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        superseded_by TEXT,
        embedding_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_status_updated
      ON memories(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memories_type_status
      ON memories(type, status);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
      USING fts5(memory_id UNINDEXED, title, content, tags, tokenize='porter');

      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memory_fts(memory_id, title, content, tags)
        VALUES (new.id, new.title, new.content, new.topics_json || ' ' || new.categories_json);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memory_fts WHERE memory_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memories BEGIN
        DELETE FROM memory_fts WHERE memory_id = old.id;
        INSERT INTO memory_fts(memory_id, title, content, tags)
        VALUES (new.id, new.title, new.content, new.topics_json || ' ' || new.categories_json);
      END;

      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY(from_id) REFERENCES memories(id),
        FOREIGN KEY(to_id) REFERENCES memories(id)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON memory_edges(type);

      CREATE TABLE IF NOT EXISTS memory_sources (
        memory_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(memory_id, source_kind, source_id),
        FOREIGN KEY(memory_id) REFERENCES memories(id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_sources_memory ON memory_sources(memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_sources_source ON memory_sources(source_kind, source_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  insertConversationMessages(messages: ConversationMessage[]): string[] {
    const statement = this.db.query(
      `INSERT INTO conversation_entries
      (id, session_id, role, content, channel, agent, speaker, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const ids: string[] = [];
    const transaction = this.db.transaction((rows: ConversationMessage[]) => {
      for (const row of rows) {
        const id = row.id ?? crypto.randomUUID();
        const createdAt = row.timestamp ?? Date.now();

        statement.run(
          id,
          row.sessionId,
          row.role,
          row.content,
          row.channel ?? null,
          row.agent ?? null,
          row.speaker ?? null,
          createdAt,
          JSON.stringify(row.metadata ?? {})
        );

        ids.push(id);
      }
    });

    transaction(messages);
    return ids;
  }

  getConversationMessages(ids: string[]): ConversationMessage[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT * FROM conversation_entries WHERE id IN (${placeholders})`)
      .all(...ids) as ConversationRow[];

    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is ConversationRow => Boolean(row))
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        channel: row.channel ?? undefined,
        agent: row.agent ?? undefined,
        speaker: row.speaker ?? undefined,
        timestamp: row.created_at,
        metadata: safeParse<Record<string, unknown>>(row.metadata_json, {})
      }));
  }

  getRecentConversation(limit = 20, sessionId?: string): ConversationMessage[] {
    const rows = sessionId
      ? (this.db
          .query(
            `SELECT * FROM conversation_entries
             WHERE session_id = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(sessionId, limit) as ConversationRow[])
      : (this.db
          .query(
            `SELECT * FROM conversation_entries
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(limit) as ConversationRow[]);

    return rows
      .toReversed()
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        channel: row.channel ?? undefined,
        agent: row.agent ?? undefined,
        speaker: row.speaker ?? undefined,
        timestamp: row.created_at,
        metadata: safeParse<Record<string, unknown>>(row.metadata_json, {})
      }));
  }

  searchConversation(query: string, limit = 20, sessionId?: string): SearchResult[] {
    const base = `
      SELECT ce.id, ce.content, bm25(conversation_fts) AS rank
      FROM conversation_fts
      JOIN conversation_entries ce ON ce.id = conversation_fts.entry_id
      WHERE conversation_fts MATCH ?
    `;

    const sql = sessionId
      ? `${base} AND ce.session_id = ? ORDER BY rank LIMIT ?`
      : `${base} ORDER BY rank LIMIT ?`;

    const rows = sessionId
      ? (this.db.query(sql).all(query, sessionId, limit) as Array<{ id: string; content: string; rank: number }>)
      : (this.db.query(sql).all(query, limit) as Array<{ id: string; content: string; rank: number }>);

    return rows.map((row) => ({
      layer: "conversation",
      id: row.id,
      title: "Conversation Entry",
      snippet: row.content.slice(0, 280),
      score: -row.rank
    }));
  }

  upsertSessionState(state: SessionState): void {
    this.db
      .query(
        `INSERT INTO session_state(session_id, summary, buffer_message_ids_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id)
         DO UPDATE SET
          summary = excluded.summary,
          buffer_message_ids_json = excluded.buffer_message_ids_json,
          updated_at = excluded.updated_at`
      )
      .run(
        state.sessionId,
        state.summary,
        JSON.stringify(state.bufferMessageIds),
        state.updatedAt
      );
  }

  getSessionState(sessionId: string): SessionState | null {
    const row = this.db
      .query(`SELECT * FROM session_state WHERE session_id = ? LIMIT 1`)
      .get(sessionId) as
      | {
          session_id: string;
          summary: string;
          buffer_message_ids_json: string;
          updated_at: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      summary: row.summary,
      bufferMessageIds: safeParse<string[]>(row.buffer_message_ids_json, []),
      updatedAt: row.updated_at
    };
  }

  countActiveSessions(): number {
    const row = this.db.query(`SELECT COUNT(*) AS count FROM session_state`).get() as {
      count: number;
    };
    return row.count;
  }

  insertDocument(params: {
    id: string;
    sourceId?: string;
    title?: string;
    content: string;
    createdAt: number;
    metadata: Record<string, unknown>;
  }): void {
    this.db
      .query(
        `INSERT INTO documents
        (id, source_id, title, content, created_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.id,
        params.sourceId ?? null,
        params.title ?? null,
        params.content,
        params.createdAt,
        JSON.stringify(params.metadata)
      );
  }

  getDocument(id: string): {
    id: string;
    sourceId?: string;
    title?: string;
    content: string;
    createdAt: number;
    metadata: Record<string, unknown>;
  } | null {
    const row = this.db.query(`SELECT * FROM documents WHERE id = ? LIMIT 1`).get(id) as
      | DocumentRow
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      sourceId: row.source_id ?? undefined,
      title: row.title ?? undefined,
      content: row.content,
      createdAt: row.created_at,
      metadata: safeParse<Record<string, unknown>>(row.metadata_json, {})
    };
  }

  insertMemory(memory: MemoryNode): void {
    this.db
      .query(
        `INSERT INTO memories
        (id, type, title, content, topics_json, categories_json, context_json,
         strength, recall_count, last_accessed, created_at, updated_at,
         created_from, confidence, status, superseded_by, embedding_json, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memory.id,
        memory.type,
        memory.title,
        memory.content,
        JSON.stringify(memory.topics),
        JSON.stringify(memory.categories),
        JSON.stringify(memory.context),
        memory.strength,
        memory.recallCount,
        memory.lastAccessed,
        memory.createdAt,
        memory.updatedAt,
        memory.createdFrom,
        memory.confidence,
        memory.status,
        memory.supersededBy,
        JSON.stringify(memory.embedding),
        JSON.stringify(memory.metadata)
      );
  }

  updateMemory(memory: MemoryNode): void {
    this.db
      .query(
        `UPDATE memories SET
          type = ?,
          title = ?,
          content = ?,
          topics_json = ?,
          categories_json = ?,
          context_json = ?,
          strength = ?,
          recall_count = ?,
          last_accessed = ?,
          created_at = ?,
          updated_at = ?,
          created_from = ?,
          confidence = ?,
          status = ?,
          superseded_by = ?,
          embedding_json = ?,
          metadata_json = ?
        WHERE id = ?`
      )
      .run(
        memory.type,
        memory.title,
        memory.content,
        JSON.stringify(memory.topics),
        JSON.stringify(memory.categories),
        JSON.stringify(memory.context),
        memory.strength,
        memory.recallCount,
        memory.lastAccessed,
        memory.createdAt,
        memory.updatedAt,
        memory.createdFrom,
        memory.confidence,
        memory.status,
        memory.supersededBy,
        JSON.stringify(memory.embedding),
        JSON.stringify(memory.metadata),
        memory.id
      );
  }

  getMemory(id: string): MemoryNode | null {
    const row = this.db.query(`SELECT * FROM memories WHERE id = ? LIMIT 1`).get(id) as
      | MemoryRow
      | undefined;

    return row ? this.mapMemoryRow(row) : null;
  }

  getMemories(ids: string[]): MemoryNode[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as MemoryRow[];

    const byId = new Map(rows.map((row) => [row.id, this.mapMemoryRow(row)]));
    return ids
      .map((id) => byId.get(id))
      .filter((memory): memory is MemoryNode => Boolean(memory));
  }

  listMemories(status: MemoryStatus | "all" = "active", limit = 1000): MemoryNode[] {
    const rows =
      status === "all"
        ? (this.db
            .query(
              `SELECT * FROM memories
               ORDER BY updated_at DESC
               LIMIT ?`
            )
            .all(limit) as MemoryRow[])
        : (this.db
            .query(
              `SELECT * FROM memories
               WHERE status = ?
               ORDER BY updated_at DESC
               LIMIT ?`
            )
            .all(status, limit) as MemoryRow[]);

    return rows.map((row) => this.mapMemoryRow(row));
  }

  searchMemories(query: string, limit = 20): SearchResult[] {
    const rows = this.db
      .query(
        `SELECT m.id, m.title, m.content, bm25(memory_fts) AS rank
         FROM memory_fts
         JOIN memories m ON m.id = memory_fts.memory_id
         WHERE memory_fts MATCH ? AND m.status = 'active'
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, limit) as Array<{
      id: string;
      title: string;
      content: string;
      rank: number;
    }>;

    return rows.map((row) => ({
      layer: "long_term",
      id: row.id,
      title: row.title,
      snippet: row.content.slice(0, 280),
      score: -row.rank
    }));
  }

  memoryCandidates(limit = 200): MemoryNode[] {
    const rows = this.db
      .query(
        `SELECT * FROM memories
         WHERE status = 'active'
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit) as MemoryRow[];

    return rows.map((row) => this.mapMemoryRow(row));
  }

  countMemoriesByType(): Record<MemoryNodeType, number> {
    const rows = this.db
      .query(
        `SELECT type, COUNT(*) AS count
         FROM memories
         GROUP BY type`
      )
      .all() as Array<{ type: MemoryNodeType; count: number }>;

    const result: Record<MemoryNodeType, number> = {
      semantic: 0,
      episodic: 0,
      procedural: 0
    };

    for (const row of rows) {
      result[row.type] = row.count;
    }

    return result;
  }

  countMemoriesByStatus(): Record<MemoryStatus, number> {
    const rows = this.db
      .query(
        `SELECT status, COUNT(*) AS count
         FROM memories
         GROUP BY status`
      )
      .all() as Array<{ status: MemoryStatus; count: number }>;

    const result: Record<MemoryStatus, number> = {
      active: 0,
      archived: 0,
      forgotten: 0
    };

    for (const row of rows) {
      result[row.status] = row.count;
    }

    return result;
  }

  averageStrength(): number {
    const row = this.db
      .query(`SELECT AVG(strength) AS avg_strength FROM memories WHERE status = 'active'`)
      .get() as {
      avg_strength: number | null;
    };

    return row.avg_strength ?? 0;
  }

  countConversationEntries(): number {
    const row = this.db.query(`SELECT COUNT(*) AS count FROM conversation_entries`).get() as {
      count: number;
    };
    return row.count;
  }

  insertEdge(edge: MemoryEdge): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO memory_edges
        (id, from_id, to_id, type, weight, created_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        edge.id,
        edge.fromId,
        edge.toId,
        edge.type,
        edge.weight,
        edge.createdAt,
        JSON.stringify(edge.metadata)
      );
  }

  getEdgesForMemory(memoryId: string): MemoryEdge[] {
    const rows = this.db
      .query(
        `SELECT * FROM memory_edges
         WHERE from_id = ? OR to_id = ?`
      )
      .all(memoryId, memoryId) as EdgeRow[];

    return rows.map((row) => this.mapEdgeRow(row));
  }

  linkMemorySource(
    memoryId: string,
    sourceKind: "conversation" | "document",
    sourceIds: string[]
  ): void {
    if (sourceIds.length === 0) {
      return;
    }

    const statement = this.db.query(
      `INSERT OR IGNORE INTO memory_sources(memory_id, source_kind, source_id, created_at)
       VALUES (?, ?, ?, ?)`
    );

    const transaction = this.db.transaction((ids: string[]) => {
      const createdAt = Date.now();
      for (const sourceId of ids) {
        statement.run(memoryId, sourceKind, sourceId, createdAt);
      }
    });

    transaction(sourceIds);
  }

  getMemorySources(memoryId: string): { sourceKind: "conversation" | "document"; sourceId: string }[] {
    const rows = this.db
      .query(
        `SELECT source_kind, source_id
         FROM memory_sources
         WHERE memory_id = ?`
      )
      .all(memoryId) as Array<{ source_kind: "conversation" | "document"; source_id: string }>;

    return rows.map((row) => ({
      sourceKind: row.source_kind,
      sourceId: row.source_id
    }));
  }

  edgeCount(): number {
    const row = this.db.query(`SELECT COUNT(*) AS count FROM memory_edges`).get() as {
      count: number;
    };

    return row.count;
  }

  getNeighborhood(seedIds: string[], depth: number, maxNodes = 150): MemoryNode[] {
    if (seedIds.length === 0 || depth <= 0) {
      return [];
    }

    const visited = new Set<string>(seedIds);
    const frontier = [...seedIds];

    for (let d = 0; d < depth; d += 1) {
      if (frontier.length === 0 || visited.size >= maxNodes) {
        break;
      }

      const current = [...frontier];
      frontier.length = 0;

      const placeholders = current.map(() => "?").join(",");
      const rows = this.db
        .query(
          `SELECT from_id, to_id
           FROM memory_edges
           WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`
        )
        .all(...current, ...current) as Array<{ from_id: string; to_id: string }>;

      for (const row of rows) {
        const next = visited.has(row.from_id) ? row.to_id : row.from_id;
        if (!visited.has(next)) {
          visited.add(next);
          frontier.push(next);
          if (visited.size >= maxNodes) {
            break;
          }
        }
      }
    }

    return this.getMemories([...visited]);
  }

  deleteEdgeByTypeBetween(
    fromId: string,
    toId: string,
    type: MemoryEdge["type"]
  ): void {
    this.db
      .query(
        `DELETE FROM memory_edges
         WHERE type = ?
         AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`
      )
      .run(type, fromId, toId, toId, fromId);
  }

  mapMemoryRow(row: MemoryRow): MemoryNode {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      topics: safeParse<string[]>(row.topics_json, []),
      categories: safeParse<string[]>(row.categories_json, []),
      context: safeParse<MemoryNode["context"]>(row.context_json, {
        sourceConversationEntryIds: [],
        sourceDocumentIds: []
      }),
      strength: row.strength,
      recallCount: row.recall_count,
      lastAccessed: row.last_accessed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdFrom: row.created_from,
      confidence: row.confidence,
      status: row.status,
      supersededBy: row.superseded_by,
      embedding: safeParse<number[]>(row.embedding_json, []),
      metadata: safeParse<Record<string, unknown>>(row.metadata_json, {})
    };
  }

  private mapEdgeRow(row: EdgeRow): MemoryEdge {
    return {
      id: row.id,
      fromId: row.from_id,
      toId: row.to_id,
      type: row.type,
      weight: row.weight,
      createdAt: row.created_at,
      metadata: safeParse<Record<string, unknown>>(row.metadata_json, {})
    };
  }
}
