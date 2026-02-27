import { defaultConfig, withConfig, type EngineConfig } from "../config";
import { OpenAICompatibleLLM } from "../llm/openai-compatible";
import { SQLiteMemoryStore } from "../storage/sqlite-store";
import { SubconsciousAgent } from "../subconscious/agent";
import {
  contradictionScore,
  extractMemories,
  type ExtractedMemoryDraft
} from "../subconscious/extraction";
import type {
  ConsolidationReport,
  ConversationMessage,
  EngineStatus,
  FactIngestion,
  IngestInput,
  IngestResult,
  MemoryEdge,
  MemoryEdgeType,
  MemoryNode,
  MemoryNodeType,
  RecallOptions,
  RecallResult,
  SearchOptions,
  SearchResult,
  SessionState,
  TraceHop,
  TraceResult,
  SubconsciousLLM
} from "../types";
import { createId } from "../utils/id";
import { createLogger } from "../utils/logger";
import { summarizeMessages, textSimilarity, topTokens } from "../utils/text";
import { curvedDecayFactor, now, recencyScore } from "../utils/time";
import { buildHashEmbedding, cosineSimilarity } from "../utils/vector";

interface EdgeCreationInput {
  fromId: string;
  toId: string;
  type: MemoryEdgeType;
  weight: number;
  metadata?: Record<string, unknown>;
}

interface GetMemoryResult {
  memory: MemoryNode;
  neighborhood: MemoryNode[];
  edges: MemoryEdge[];
  sources: Array<{ sourceKind: "conversation" | "document"; sourceId: string }>;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const dedupe = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

const isSubconsciousEchoText = (value: string): boolean => {
  const normalized = value.trim();
  return (
    normalized.startsWith("Working Memory for query:") ||
    normalized.startsWith("[Subconscious Memory]") ||
    normalized.includes("\nWorking Memory for query:")
  );
};

const makeEdgeId = (fromId: string, toId: string, type: MemoryEdgeType): string =>
  `edge_${type}_${fromId}_${toId}`;

const hourMs = 60 * 60 * 1000;

export class MemoryEngine {
  readonly config: EngineConfig;

  private readonly store: SQLiteMemoryStore;
  private readonly subconscious: SubconsciousAgent;
  private readonly llm?: SubconsciousLLM;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly startedAt: number;

  private consolidationRunning = false;
  private decayRunning = false;

  constructor(configOverrides?: Partial<EngineConfig>) {
    this.config = withConfig(configOverrides);
    this.store = new SQLiteMemoryStore(this.config.dbPath);
    this.startedAt = now();
    this.logger = createLogger("memory-engine", this.config.logLevel);

    if (this.config.llm.enabled && this.config.llm.provider === "openai_compatible") {
      this.llm = new OpenAICompatibleLLM({
        endpoint: this.config.llm.endpoint,
        apiKey: this.config.llm.apiKey,
        model: this.config.llm.model,
        temperature: this.config.llm.temperature
      });
    }

    this.subconscious = new SubconsciousAgent(
      {
        processConversationTask: (task) => this.processConversationTask(task.sessionId, task.messageIds),
        consolidateCycle: async () => {
          await this.consolidate();
        },
        decayCycle: () => this.runDecayCycle()
      },
      {
        queuePollIntervalMs: this.config.queuePollIntervalMs,
        consolidateIntervalMs: this.config.consolidateIntervalMs,
        decayIntervalMs: this.config.decayIntervalMs,
        logLevel: this.config.logLevel
      }
    );

    this.subconscious.start();
    this.logger.info("engine started", {
      dbPath: this.config.dbPath,
      llmEnabled: Boolean(this.llm),
      logLevel: this.config.logLevel
    });
  }

  async shutdown(): Promise<void> {
    this.logger.info("engine shutdown requested");
    this.subconscious.stop();
    await this.subconscious.flush();
    this.store.close();
    this.logger.info("engine shutdown complete");
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    if (input.kind === "conversation") {
      if (input.messages.length === 0) {
        return { conversationEntryIds: [], extractedMemoryIds: [] };
      }

      this.logger.debug("ingest conversation", {
        messageCount: input.messages.length
      });

      const grouped = new Map<string, typeof input.messages>();
      for (const message of input.messages) {
        const existing = grouped.get(message.sessionId);
        if (existing) {
          existing.push(message);
        } else {
          grouped.set(message.sessionId, [message]);
        }
      }

      const allConversationIds: string[] = [];
      for (const [sessionId, messages] of grouped.entries()) {
        const ids = this.store.insertConversationMessages(messages);
        allConversationIds.push(...ids);
        this.updateShortTermState(sessionId, ids);
        this.subconscious.enqueueConversation(sessionId, ids);
      }

      this.logger.info("ingested conversation entries", {
        entryCount: allConversationIds.length,
        sessionCount: grouped.size,
        queueDepth: this.subconscious.getQueueDepth()
      });

      return {
        conversationEntryIds: allConversationIds,
        extractedMemoryIds: []
      };
    }

    if (input.kind === "document") {
      const documentId = input.document.id ?? createId("doc");
      const createdAt = input.document.timestamp ?? now();

      this.logger.debug("ingest document", {
        documentId,
        hasTitle: Boolean(input.document.title),
        contentLength: input.document.content.length
      });

      this.store.insertDocument({
        id: documentId,
        sourceId: input.document.sourceId,
        title: input.document.title,
        content: input.document.content,
        createdAt,
        metadata: input.document.metadata ?? {}
      });

      const chunks = this.chunkText(input.document.content, 950);
      const fakeMessages = chunks.map((chunk) => ({
        sessionId: `document:${documentId}`,
        role: "system" as const,
        content: chunk,
        timestamp: createdAt,
        metadata: {
          documentId,
          type: "document_chunk"
        }
      }));

      const drafts = await extractMemories({
        messages: fakeMessages,
        currentSummary: input.document.title ?? "",
        llm: this.llm
      });

      const fallbackDrafts = drafts.length
        ? drafts
        : [
            {
              type: "semantic" as const,
              title: input.document.title ?? "Document Memory",
              content: chunks[0] ?? input.document.content.slice(0, 900),
              topics: topTokens(input.document.content, 8),
              categories: ["document", "fact"],
              confidence: 0.65
            }
          ];

      const createdIds: string[] = [];
      for (const draft of fallbackDrafts) {
        const memory = this.createMemoryFromDraft({
          draft,
          createdFrom: "document",
          sessionId: `document:${documentId}`,
          sourceConversationEntryIds: [],
          sourceDocumentIds: [documentId],
          timestamp: createdAt,
          metadata: {
            documentTitle: input.document.title
          }
        });

        this.store.insertMemory(memory);
        this.store.linkMemorySource(memory.id, "document", [documentId]);
        await this.associateAndResolve(memory, this.store.memoryCandidates(this.config.candidatePoolSize));
        createdIds.push(memory.id);
      }

      this.logger.info("ingested document memories", {
        documentId,
        memoryCount: createdIds.length
      });

      return {
        conversationEntryIds: [],
        extractedMemoryIds: createdIds
      };
    }

    const factIds = await this.ingestFact(input.fact);
    this.logger.info("ingested fact memories", {
      memoryCount: factIds.length
    });
    return {
      conversationEntryIds: [],
      extractedMemoryIds: factIds
    };
  }

  async recall(query: string, options?: RecallOptions): Promise<RecallResult> {
    this.logger.debug("recall requested", {
      sessionId: options?.sessionId,
      limit: options?.limit ?? this.config.workingMemorySize
    });

    if (this.subconscious.getQueueDepth() > 0) {
      this.logger.debug("flushing queue before recall", {
        queueDepth: this.subconscious.getQueueDepth()
      });
      await this.subconscious.flush();
    }

    const sessionId = options?.sessionId;
    const limit = options?.limit ?? this.config.workingMemorySize;
    const nowMs = now();

    const queryEmbedding = buildHashEmbedding(query, this.config.embeddingDimensions);

    const baseCandidates = this.store.memoryCandidates(this.config.candidatePoolSize);
    const scoredBase = baseCandidates
      .filter(
        (memory) => memory.status === "active" && !isSubconsciousEchoText(memory.content)
      )
      .map((memory) => {
        const semantic = cosineSimilarity(queryEmbedding, memory.embedding);
        const lexical = textSimilarity(query, `${memory.title} ${memory.content}`);
        const contentScore = semantic * 0.7 + lexical * 0.3;
        return {
          memory,
          contentScore
        };
      })
      .sort((a, b) => b.contentScore - a.contentScore)
      .slice(0, Math.max(limit * 3, 12));

    const seedIds = scoredBase.map((entry) => entry.memory.id);
    const expanded = this.store.getNeighborhood(
      seedIds,
      this.config.graphExpansionDepth,
      this.config.candidatePoolSize
    );

    const byId = new Map<string, MemoryNode>();
    for (const entry of scoredBase) {
      byId.set(entry.memory.id, entry.memory);
    }
    for (const candidate of expanded) {
      if (candidate.status === "active") {
        byId.set(candidate.id, candidate);
      }
    }

    const candidates = [...byId.values()];
    const scored = candidates
      .map((memory) => {
        const semantic = cosineSimilarity(queryEmbedding, memory.embedding);
        const lexical = textSimilarity(query, `${memory.title} ${memory.content}`);
        const contentScore = semantic * 0.7 + lexical * 0.3;

        const recency = recencyScore(memory.lastAccessed ?? memory.updatedAt, nowMs);
        const strength = clamp(memory.strength, 0, 1.5) / 1.5;

        const edges = this.store.getEdgesForMemory(memory.id);
        const relationStrength =
          edges.length === 0
            ? 0
            : clamp(
                edges.reduce((sum, edge) => sum + edge.weight, 0) /
                  Math.max(edges.length, 1),
                0,
                1
              );

        const sessionBoost =
          sessionId && memory.context.sessionId === sessionId
            ? 0.12
            : sessionId
              ? -0.02
              : 0;

        const score =
          contentScore * 0.45 +
          recency * 0.17 +
          strength * 0.18 +
          relationStrength * 0.15 +
          sessionBoost;

        const reasons = [
          `content=${contentScore.toFixed(2)}`,
          `recency=${recency.toFixed(2)}`,
          `strength=${strength.toFixed(2)}`,
          `associative=${relationStrength.toFixed(2)}`
        ];

        return {
          memory,
          score,
          reasons
        };
      })
      .sort((a, b) => b.score - a.score);

    const selected: Array<{ memory: MemoryNode; score: number; reasons: string[] }> = [];
    const seenTopics = new Set<string>();

    for (const candidate of scored) {
      if (selected.length >= limit) {
        break;
      }

      const overlappingTopics = candidate.memory.topics.filter((topic) => seenTopics.has(topic)).length;
      const noveltyPenalty = overlappingTopics / Math.max(candidate.memory.topics.length, 1);

      const topScore = selected[0]?.score;
      if (topScore && noveltyPenalty > 0.8 && candidate.score < topScore * 0.9) {
        continue;
      }

      selected.push(candidate);
      for (const topic of candidate.memory.topics) {
        seenTopics.add(topic);
      }
    }

    for (const entry of selected) {
      const refreshBoost = this.computeRecallRefreshBoost(entry.memory, nowMs);
      const updated: MemoryNode = {
        ...entry.memory,
        recallCount: entry.memory.recallCount + 1,
        lastAccessed: nowMs,
        strength: clamp(entry.memory.strength + refreshBoost, this.config.minStrength, 1.5),
        updatedAt: nowMs
      };
      this.store.updateMemory(updated);
      entry.memory = updated;
    }

    const context = this.formatWorkingMemoryContext(query, selected, options?.detailLevel ?? "summary");

    this.logger.info("recall completed", {
      sessionId,
      selected: selected.length,
      totalCandidates: candidates.length,
      expandedCandidates: expanded.length
    });

    return {
      query,
      sessionId,
      items: selected,
      context,
      totalCandidates: candidates.length,
      expandedCandidates: expanded.length
    };
  }

  search(query: string, opts?: SearchOptions): SearchResult[] {
    const layer = opts?.layer ?? "all";
    const limit = opts?.limit ?? 20;

    const results: SearchResult[] = [];

    if (layer === "all" || layer === "conversation") {
      results.push(...this.store.searchConversation(query, limit, opts?.sessionId));
    }

    if (layer === "all" || layer === "long_term") {
      const longTerm = this.store.searchMemories(query, limit).filter((result) => {
        const memory = this.store.getMemory(result.id);
        return !memory || !isSubconsciousEchoText(memory.content);
      });
      results.push(...longTerm);
    }

    if ((layer === "all" || layer === "short_term") && opts?.sessionId) {
      const session = this.store.getSessionState(opts.sessionId);
      if (session) {
        const shortTermScore = textSimilarity(query, session.summary);
        if (shortTermScore > 0) {
          results.push({
            layer: "short_term",
            id: session.sessionId,
            title: "Session Summary",
            snippet: session.summary.slice(0, 280),
            score: shortTermScore
          });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  getRecentConversation(options?: {
    sessionId?: string;
    limit?: number;
    fallbackGlobal?: boolean;
  }): ConversationMessage[] {
    const requestedLimit = options?.limit;
    const numericLimit =
      typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
        ? requestedLimit
        : 8;
    const limit = clamp(Math.floor(numericLimit), 1, 100);

    if (options?.sessionId) {
      const scoped = this.store.getRecentConversation(limit, options.sessionId);
      if (scoped.length > 0 || options.fallbackGlobal === false) {
        return scoped;
      }
    }

    return this.store.getRecentConversation(limit);
  }

  get(memoryId: string): GetMemoryResult | null {
    const memory = this.store.getMemory(memoryId);
    if (!memory) {
      return null;
    }

    return {
      memory,
      neighborhood: this.store.getNeighborhood([memoryId], 2, 64),
      edges: this.store.getEdgesForMemory(memoryId),
      sources: this.store.getMemorySources(memoryId)
    };
  }

  trace(memoryId: string): TraceResult | null {
    const root = this.store.getMemory(memoryId);
    if (!root) {
      return null;
    }

    const hops: TraceHop[] = [];
    const visited = new Set<string>();
    const queue = [root.id];
    const conversationIds = new Set<string>();

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId || visited.has(currentId)) {
        continue;
      }

      visited.add(currentId);
      const memory = this.store.getMemory(currentId);
      if (!memory) {
        continue;
      }

      const edges = this.store
        .getEdgesForMemory(currentId)
        .filter((edge) => edge.type === "sourced_from" && edge.fromId === currentId);
      const sourceMemoryIds = edges.map((edge) => edge.toId);
      for (const sourceMemoryId of sourceMemoryIds) {
        if (!visited.has(sourceMemoryId)) {
          queue.push(sourceMemoryId);
        }
      }

      const explicitSources = this.store.getMemorySources(currentId);
      const convIds = explicitSources
        .filter((source) => source.sourceKind === "conversation")
        .map((source) => source.sourceId);

      for (const convId of convIds) {
        conversationIds.add(convId);
      }

      for (const convId of memory.context.sourceConversationEntryIds) {
        conversationIds.add(convId);
      }

      hops.push({
        memoryId: currentId,
        sourceMemoryIds,
        conversationEntryIds: dedupe(convIds)
      });
    }

    const conversation = this.store.getConversationMessages([...conversationIds]);

    return {
      memory: root,
      hops,
      conversation
    };
  }

  async consolidate(): Promise<ConsolidationReport> {
    if (this.consolidationRunning) {
      this.logger.debug("consolidation skipped: already running");
      return {
        merged: 0,
        superseded: 0,
        decayed: 0,
        archived: 0,
        strengthened: 0
      };
    }

    this.consolidationRunning = true;
    this.logger.debug("consolidation started");

    try {
      const memories = this.store.listMemories("active", 500);
      const report: ConsolidationReport = {
        merged: 0,
        superseded: 0,
        decayed: 0,
        archived: 0,
        strengthened: 0
      };

      const consumed = new Set<string>();
      for (let i = 0; i < memories.length; i += 1) {
        const a = memories[i];
        if (!a) {
          continue;
        }

        if (consumed.has(a.id)) {
          continue;
        }

        for (let j = i + 1; j < memories.length; j += 1) {
          const b = memories[j];
          if (!b) {
            continue;
          }

          if (consumed.has(b.id) || a.type !== b.type) {
            continue;
          }

          const similarity =
            cosineSimilarity(a.embedding, b.embedding) * 0.7 + textSimilarity(a.content, b.content) * 0.3;

          if (similarity < 0.92) {
            continue;
          }

          const keep = a.strength >= b.strength ? a : b;
          const archive = keep.id === a.id ? b : a;

          keep.strength = clamp(
            keep.strength + archive.strength * 0.25,
            this.config.minStrength,
            1.5
          );
          keep.recallCount += archive.recallCount;
          keep.updatedAt = now();
          keep.context.sourceConversationEntryIds = dedupe([
            ...keep.context.sourceConversationEntryIds,
            ...archive.context.sourceConversationEntryIds
          ]);
          keep.context.sourceDocumentIds = dedupe([
            ...keep.context.sourceDocumentIds,
            ...archive.context.sourceDocumentIds
          ]);

          archive.status = "archived";
          archive.supersededBy = keep.id;
          archive.updatedAt = now();

          this.store.updateMemory(keep);
          this.store.updateMemory(archive);

          this.addEdge({
            fromId: archive.id,
            toId: keep.id,
            type: "supersedes",
            weight: 0.95,
            metadata: { reason: "consolidation_duplicate" }
          });

          const archiveSources = this.store.getMemorySources(archive.id);
          this.store.linkMemorySource(
            keep.id,
            "conversation",
            archiveSources
              .filter((source) => source.sourceKind === "conversation")
              .map((source) => source.sourceId)
          );
          this.store.linkMemorySource(
            keep.id,
            "document",
            archiveSources
              .filter((source) => source.sourceKind === "document")
              .map((source) => source.sourceId)
          );

          consumed.add(archive.id);
          report.merged += 1;
          report.superseded += 1;
          report.archived += 1;
        }
      }

      this.logger.info("consolidation finished", report);
      return report;
    } finally {
      this.consolidationRunning = false;
    }
  }

  forget(memoryId: string): boolean {
    const memory = this.store.getMemory(memoryId);
    if (!memory) {
      return false;
    }

    memory.status = "forgotten";
    memory.strength = this.config.minStrength;
    memory.updatedAt = now();
    this.store.updateMemory(memory);
    this.logger.info("memory forgotten", { memoryId });
    return true;
  }

  archive(memoryId: string): boolean {
    const memory = this.store.getMemory(memoryId);
    if (!memory) {
      return false;
    }

    memory.status = "archived";
    memory.updatedAt = now();
    this.store.updateMemory(memory);
    this.logger.info("memory archived", { memoryId });
    return true;
  }

  reinforce(memoryId: string, amount = 0.2): boolean {
    const memory = this.store.getMemory(memoryId);
    if (!memory || memory.status !== "active") {
      return false;
    }

    memory.strength = clamp(memory.strength + amount, this.config.minStrength, 1.5);
    memory.recallCount += 1;
    memory.lastAccessed = now();
    memory.updatedAt = now();
    this.store.updateMemory(memory);
    this.logger.debug("memory reinforced", { memoryId, amount });
    return true;
  }

  associate(a: string, b: string, edge: MemoryEdgeType, weight = 0.65): boolean {
    if (!this.store.getMemory(a) || !this.store.getMemory(b)) {
      return false;
    }

    this.addEdge({
      fromId: a,
      toId: b,
      type: edge,
      weight,
      metadata: { source: "manual" }
    });

    return true;
  }

  status(): EngineStatus {
    return {
      now: now(),
      memoryCountsByType: this.store.countMemoriesByType(),
      memoryCountsByStatus: this.store.countMemoriesByStatus(),
      edgeCount: this.store.edgeCount(),
      conversationEntryCount: this.store.countConversationEntries(),
      activeSessions: this.store.countActiveSessions(),
      queueDepth: this.subconscious.getQueueDepth(),
      averageStrength: this.store.averageStrength()
    };
  }

  private async ingestFact(fact: FactIngestion): Promise<string[]> {
    const timestamp = fact.timestamp ?? now();

    const draft: ExtractedMemoryDraft = {
      type: fact.type ?? "semantic",
      title: fact.title ?? "Fact",
      content: fact.content,
      topics: fact.topics ?? topTokens(fact.content, 8),
      categories: fact.categories ?? ["fact"],
      confidence: fact.confidence ?? 0.8
    };

    const memory = this.createMemoryFromDraft({
      draft,
      createdFrom: "fact",
      sourceConversationEntryIds: fact.sourceConversationEntryIds ?? [],
      sourceDocumentIds: [],
      timestamp,
      metadata: fact.metadata ?? {}
    });

    this.store.insertMemory(memory);
    this.store.linkMemorySource(memory.id, "conversation", fact.sourceConversationEntryIds ?? []);
    await this.associateAndResolve(memory, this.store.memoryCandidates(this.config.candidatePoolSize));

    return [memory.id];
  }

  private updateShortTermState(sessionId: string, newMessageIds: string[]): void {
    const existing = this.store.getSessionState(sessionId);

    const mergedIds = dedupe([...(existing?.bufferMessageIds ?? []), ...newMessageIds]).slice(
      -this.config.shortTermBufferSize
    );

    const messages = this.store.getConversationMessages(mergedIds);
    const summary = summarizeMessages(
      messages.slice(-this.config.shortTermSummaryMessages).map((msg) => ({
        role: msg.role,
        content: msg.content
      })),
      1800
    );

    const nextState: SessionState = {
      sessionId,
      summary: summary || existing?.summary || "",
      bufferMessageIds: mergedIds,
      updatedAt: now()
    };

    this.store.upsertSessionState(nextState);
  }

  private async processConversationTask(sessionId: string, messageIds: string[]): Promise<void> {
    this.logger.debug("processing conversation task", {
      sessionId,
      messageCount: messageIds.length
    });

    const messages = this.store.getConversationMessages(messageIds);
    if (messages.length === 0) {
      this.logger.debug("conversation task had no messages", { sessionId });
      return;
    }

    const currentSession = this.store.getSessionState(sessionId);
    const drafts = await extractMemories({
      messages,
      currentSummary: currentSession?.summary ?? "",
      llm: this.llm
    });

    const filteredDrafts = drafts.filter((draft) => !isSubconsciousEchoText(draft.content));

    this.logger.debug("extracted memory drafts", {
      sessionId,
      draftCount: drafts.length,
      filteredDraftCount: filteredDrafts.length
    });

    if (filteredDrafts.length < drafts.length) {
      this.logger.debug("dropped subconscious echo drafts", {
        sessionId,
        dropped: drafts.length - filteredDrafts.length
      });
    }

    const created: MemoryNode[] = [];
    for (const draft of filteredDrafts) {
      const memory = this.createMemoryFromDraft({
        draft,
        createdFrom: "conversation",
        sessionId,
        sourceConversationEntryIds: messageIds,
        sourceDocumentIds: [],
        timestamp: messages[messages.length - 1]?.timestamp,
        metadata: {
          channel: messages[messages.length - 1]?.channel,
          agent: messages[messages.length - 1]?.agent
        }
      });

      this.store.insertMemory(memory);
      this.store.linkMemorySource(memory.id, "conversation", messageIds);
      created.push(memory);
    }

    const candidates = this.store.memoryCandidates(this.config.candidatePoolSize);
    for (const memory of created) {
      await this.associateAndResolve(memory, candidates);
    }

    await this.refreshSessionSummary(sessionId, messages);
    this.logger.info("conversation task completed", {
      sessionId,
      extractedMemories: created.length
    });
  }

  private async refreshSessionSummary(
    sessionId: string,
    latestMessages: Array<{
      role: "user" | "assistant" | "system" | "tool" | "other";
      content: string;
      sessionId: string;
    }>
  ): Promise<void> {
    const current = this.store.getSessionState(sessionId);
    if (!current) {
      return;
    }

    let summary = summarizeMessages(latestMessages, 1500);

    if (this.llm) {
      const llmSummary = await this.llm.summarize({
        previousSummary: current.summary,
        messages: latestMessages.map((message) => ({
          sessionId: message.sessionId,
          role: message.role,
          content: message.content
        }))
      });

      if (llmSummary) {
        summary = llmSummary;
      }
    }

    this.store.upsertSessionState({
      ...current,
      summary: summary || current.summary,
      updatedAt: now()
    });

    this.logger.debug("session summary refreshed", {
      sessionId,
      usedLLM: Boolean(this.llm),
      summaryLength: (summary || current.summary).length
    });
  }

  private createMemoryFromDraft(params: {
    draft: ExtractedMemoryDraft;
    createdFrom: MemoryNode["createdFrom"];
    sessionId?: string;
    sourceConversationEntryIds: string[];
    sourceDocumentIds: string[];
    timestamp?: number;
    metadata: Record<string, unknown>;
  }): MemoryNode {
    const createdAt = params.timestamp ?? now();
    const title = params.draft.title || `${params.draft.type.toUpperCase()} Memory`;
    const content = params.draft.content.trim();

    const textForEmbedding = `${title}\n${content}\n${params.draft.topics.join(" ")}`;

    return {
      id: createId("mem"),
      type: params.draft.type,
      title,
      content,
      topics: dedupe(params.draft.topics.length ? params.draft.topics : topTokens(content, 8)),
      categories: dedupe(
        params.draft.categories.length ? params.draft.categories : [params.draft.type, "fact"]
      ),
      context: {
        sessionId: params.sessionId,
        timestamp: createdAt,
        sourceConversationEntryIds: params.sourceConversationEntryIds,
        sourceDocumentIds: params.sourceDocumentIds,
        channel: (params.metadata.channel as string | undefined) ?? undefined,
        agent: (params.metadata.agent as string | undefined) ?? undefined,
        speaker: (params.metadata.speaker as string | undefined) ?? undefined
      },
      strength: clamp(0.35 + params.draft.confidence * 0.7, this.config.minStrength, 1.2),
      recallCount: 0,
      lastAccessed: null,
      createdAt,
      updatedAt: createdAt,
      createdFrom: params.createdFrom,
      confidence: clamp(params.draft.confidence, 0.05, 1),
      status: "active",
      supersededBy: null,
      embedding: buildHashEmbedding(textForEmbedding, this.config.embeddingDimensions),
      metadata: params.metadata
    };
  }

  private async associateAndResolve(memory: MemoryNode, candidates: MemoryNode[]): Promise<void> {
    const pool = candidates.filter((candidate) => candidate.id !== memory.id && candidate.status === "active");
    if (pool.length === 0) {
      return;
    }

    const scored = pool
      .map((candidate) => {
        const semantic = cosineSimilarity(memory.embedding, candidate.embedding);
        const lexical = textSimilarity(memory.content, candidate.content);
        const score = semantic * 0.65 + lexical * 0.35;
        return { candidate, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    for (const match of scored) {
      if (match.score >= 0.5) {
        this.addEdge({
          fromId: memory.id,
          toId: match.candidate.id,
          type: "related_to",
          weight: clamp(match.score, 0.45, 0.95),
          metadata: { source: "association" }
        });
      }

      if (match.score >= 0.74) {
        this.addEdge({
          fromId: memory.id,
          toId: match.candidate.id,
          type: "reinforces",
          weight: clamp(match.score, 0.5, 1),
          metadata: { source: "high_similarity" }
        });
      }

      const contradiction = contradictionScore(memory, match.candidate);
      if (contradiction >= 0.8) {
        const resolved = await this.resolveContradiction(match.candidate, memory, contradiction);
        if (!resolved) {
          this.addEdge({
            fromId: memory.id,
            toId: match.candidate.id,
            type: "contradicts",
            weight: contradiction,
            metadata: { source: "heuristic_contradiction" }
          });
        }
      }
    }
  }

  private async resolveContradiction(
    existing: MemoryNode,
    incoming: MemoryNode,
    score: number
  ): Promise<boolean> {
    let action: "supersede" | "flag" | "keep_both" = "keep_both";

    if (this.llm) {
      const llmResult = await this.llm.resolveContradiction({ existing, incoming });
      if (llmResult) {
        action = llmResult.action;
      }
    } else if (score >= 0.92 && incoming.createdAt >= existing.createdAt) {
      action = "supersede";
    } else if (score >= 0.87) {
      action = "flag";
    }

    if (action === "supersede") {
      existing.status = "archived";
      existing.supersededBy = incoming.id;
      existing.updatedAt = now();
      this.store.updateMemory(existing);

      this.addEdge({
        fromId: existing.id,
        toId: incoming.id,
        type: "supersedes",
        weight: clamp(score, 0.7, 1),
        metadata: { source: "contradiction_resolution" }
      });

      const sources = this.store.getMemorySources(existing.id);
      this.store.linkMemorySource(
        incoming.id,
        "conversation",
        sources
          .filter((source) => source.sourceKind === "conversation")
          .map((source) => source.sourceId)
      );
      this.store.linkMemorySource(
        incoming.id,
        "document",
        sources.filter((source) => source.sourceKind === "document").map((source) => source.sourceId)
      );
      this.logger.info("contradiction resolved by supersede", {
        existingId: existing.id,
        incomingId: incoming.id,
        score: Number(score.toFixed(3))
      });
      return true;
    }

    if (action === "flag") {
      this.addEdge({
        fromId: incoming.id,
        toId: existing.id,
        type: "contradicts",
        weight: clamp(score, 0.6, 1),
        metadata: {
          source: "contradiction_flag",
          requiresReview: true
        }
      });
      this.logger.info("contradiction flagged for review", {
        existingId: existing.id,
        incomingId: incoming.id,
        score: Number(score.toFixed(3))
      });
      return true;
    }

    return false;
  }

  private addEdge(input: EdgeCreationInput): void {
    const edge: MemoryEdge = {
      id: makeEdgeId(input.fromId, input.toId, input.type),
      fromId: input.fromId,
      toId: input.toId,
      type: input.type,
      weight: clamp(input.weight, 0, 1),
      createdAt: now(),
      metadata: input.metadata ?? {}
    };

    this.store.insertEdge(edge);
  }

  private formatWorkingMemoryContext(
    query: string,
    entries: Array<{ memory: MemoryNode; score: number; reasons: string[] }>,
    detailLevel: "summary" | "full"
  ): string {
    const lines: string[] = [];
    lines.push(`Working Memory for query: ${query}`);
    lines.push(`Selected ${entries.length} memories`);

    for (const [index, entry] of entries.entries()) {
      const memory = entry.memory;
      lines.push(`\n[${index + 1}] ${memory.type.toUpperCase()} | ${memory.title}`);
      lines.push(`score=${entry.score.toFixed(3)} strength=${memory.strength.toFixed(2)} confidence=${memory.confidence.toFixed(2)}`);
      lines.push(`topics=${memory.topics.join(", ") || "none"} categories=${memory.categories.join(", ") || "none"}`);
      lines.push(`reasons=${entry.reasons.join("; ")}`);
      lines.push(detailLevel === "full" ? `content=${memory.content}` : `summary=${memory.content.slice(0, 220)}`);
    }

    return lines.join("\n");
  }

  private chunkText(text: string, maxChunkSize: number): string[] {
    const clean = text.trim();
    if (!clean) {
      return [];
    }

    const paragraphs = clean.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean);
    if (paragraphs.length === 0) {
      return [clean.slice(0, maxChunkSize)];
    }

    const chunks: string[] = [];
    let current = "";

    for (const paragraph of paragraphs) {
      if ((current + "\n\n" + paragraph).length <= maxChunkSize) {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
      } else {
        if (current) {
          chunks.push(current);
        }

        if (paragraph.length <= maxChunkSize) {
          current = paragraph;
        } else {
          const parts = paragraph.match(new RegExp(`.{1,${maxChunkSize}}`, "g")) ?? [paragraph];
          chunks.push(...parts.slice(0, -1));
          current = parts[parts.length - 1] ?? "";
        }
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  private computeRecallRefreshBoost(memory: MemoryNode, nowMs: number): number {
    const baseline = Math.max(memory.lastAccessed ?? 0, memory.updatedAt);
    const elapsedHours = Math.max(0, nowMs - baseline) / hourMs;
    const window = Math.max(1, this.config.recallRefreshWindowHours);
    const staleness = clamp(elapsedHours / window, 0, 1);

    return (
      this.config.recallRefreshBaseBoost +
      (this.config.recallRefreshMaxBoost - this.config.recallRefreshBaseBoost) * staleness
    );
  }

  private async runDecayCycle(): Promise<void> {
    if (this.decayRunning) {
      this.logger.debug("decay skipped: already running");
      return;
    }

    this.decayRunning = true;
    this.logger.debug("decay cycle started");

    try {
      const nowMs = now();
      const memories = this.store.listMemories("active", 2000);
      let decayed = 0;
      let archived = 0;

      for (const memory of memories) {
        const baseline = Math.max(memory.lastAccessed ?? 0, memory.updatedAt);
        const elapsedMs = Math.max(0, nowMs - baseline);
        const factor = curvedDecayFactor(
          elapsedMs,
          this.config.decayHalfLifeHours,
          this.config.decayCurveShape
        );

        const nextStrength = clamp(memory.strength * factor, this.config.minStrength, 1.5);
        const shouldArchive =
          this.config.autoArchiveOnDecay && nextStrength < this.config.archiveStrengthThreshold;

        if (Math.abs(nextStrength - memory.strength) < 0.005 && !shouldArchive) {
          continue;
        }

        memory.strength = nextStrength;
        memory.updatedAt = nowMs;
        if (shouldArchive) {
          memory.status = "archived";
          archived += 1;
        }

        this.store.updateMemory(memory);
        decayed += 1;
      }

      this.logger.info("decay cycle finished", {
        scanned: memories.length,
        decayed,
        archived
      });
    } catch (error) {
      this.logger.error("decay cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      this.decayRunning = false;
    }
  }
}

export const createMemoryEngine = (config?: Partial<EngineConfig>): MemoryEngine =>
  new MemoryEngine(config);
