export type MemoryNodeType = "semantic" | "episodic" | "procedural";

export type MemoryEdgeType =
  | "related_to"
  | "caused_by"
  | "led_to"
  | "supersedes"
  | "reinforces"
  | "contradicts"
  | "sourced_from"
  | "part_of";

export type MemoryStatus = "active" | "archived" | "forgotten";

export interface ConversationMessage {
  id?: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool" | "other";
  content: string;
  channel?: string;
  agent?: string;
  speaker?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface DocumentIngestion {
  id?: string;
  sourceId?: string;
  title?: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface FactIngestion {
  id?: string;
  type?: MemoryNodeType;
  title?: string;
  content: string;
  topics?: string[];
  categories?: string[];
  confidence?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
  sourceConversationEntryIds?: string[];
}

export type IngestInput =
  | {
      kind: "conversation";
      messages: ConversationMessage[];
    }
  | {
      kind: "document";
      document: DocumentIngestion;
    }
  | {
      kind: "fact";
      fact: FactIngestion;
    };

export interface MemoryContext {
  channel?: string;
  sessionId?: string;
  agent?: string;
  speaker?: string;
  timestamp?: number;
  sourceConversationEntryIds: string[];
  sourceDocumentIds: string[];
}

export interface MemoryNode {
  id: string;
  type: MemoryNodeType;
  title: string;
  content: string;
  topics: string[];
  categories: string[];
  context: MemoryContext;
  strength: number;
  recallCount: number;
  lastAccessed: number | null;
  createdAt: number;
  updatedAt: number;
  createdFrom: "conversation" | "document" | "fact" | "subconscious";
  confidence: number;
  status: MemoryStatus;
  supersededBy: string | null;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface MemoryEdge {
  id: string;
  fromId: string;
  toId: string;
  type: MemoryEdgeType;
  weight: number;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface WorkingMemoryItem {
  memory: MemoryNode;
  score: number;
  reasons: string[];
}

export interface RecallOptions {
  sessionId?: string;
  limit?: number;
  includeTrace?: boolean;
  detailLevel?: "summary" | "full";
}

export interface RecallResult {
  query: string;
  sessionId?: string;
  items: WorkingMemoryItem[];
  context: string;
  totalCandidates: number;
  expandedCandidates: number;
}

export interface SearchOptions {
  layer?: "all" | "conversation" | "short_term" | "long_term";
  sessionId?: string;
  limit?: number;
}

export interface SearchResult {
  layer: "conversation" | "short_term" | "long_term";
  id: string;
  title: string;
  snippet: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SessionState {
  sessionId: string;
  summary: string;
  bufferMessageIds: string[];
  updatedAt: number;
}

export interface TraceHop {
  memoryId: string;
  sourceMemoryIds: string[];
  conversationEntryIds: string[];
}

export interface TraceResult {
  memory: MemoryNode;
  hops: TraceHop[];
  conversation: ConversationMessage[];
}

export interface EngineStatus {
  now: number;
  memoryCountsByType: Record<MemoryNodeType, number>;
  memoryCountsByStatus: Record<MemoryStatus, number>;
  edgeCount: number;
  conversationEntryCount: number;
  activeSessions: number;
  queueDepth: number;
  averageStrength: number;
}

export interface ConsolidationReport {
  merged: number;
  superseded: number;
  decayed: number;
  archived: number;
  strengthened: number;
}

export interface IngestResult {
  conversationEntryIds: string[];
  extractedMemoryIds: string[];
}

export interface LLMExtractionResult {
  memories: Array<{
    type: MemoryNodeType;
    title: string;
    content: string;
    topics: string[];
    categories: string[];
    confidence: number;
  }>;
  summary?: string;
}

export interface LLMContradictionResult {
  action: "supersede" | "flag" | "keep_both";
  confidence: number;
  reason?: string;
}

export interface SubconsciousLLM {
  extract(payload: {
    messages: ConversationMessage[];
    currentSummary: string;
  }): Promise<LLMExtractionResult | null>;
  summarize(payload: {
    previousSummary: string;
    messages: ConversationMessage[];
  }): Promise<string | null>;
  resolveContradiction(payload: {
    existing: MemoryNode;
    incoming: MemoryNode;
  }): Promise<LLMContradictionResult | null>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AdapterSession {
  sessionId: string;
  channel?: string;
  agent?: string;
  initialPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface AdapterMessage {
  sessionId: string;
  role: ConversationMessage["role"];
  content: string;
  timestamp?: number;
  channel?: string;
  agent?: string;
  speaker?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryAdapter {
  onConversationMessage(msg: AdapterMessage): Promise<void>;
  onSessionStart(session: AdapterSession): Promise<string>;
  onBeforeAgentRun(prompt: string, session: AdapterSession): Promise<string>;
  onAfterAgentRun(messages: AdapterMessage[], session: AdapterSession): Promise<void>;
  onContextOverflow(session: AdapterSession): Promise<void>;
  onSessionEnd(session: AdapterSession): Promise<void>;
  getTools(): ToolDefinition[];
  getWorkingMemory(query: string, session: AdapterSession): Promise<string>;
}
