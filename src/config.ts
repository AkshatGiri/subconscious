export interface EngineConfig {
  dbPath: string;
  shortTermBufferSize: number;
  shortTermSummaryMessages: number;
  workingMemorySize: number;
  embeddingDimensions: number;
  decayHalfLifeHours: number;
  minStrength: number;
  archiveStrengthThreshold: number;
  consolidateIntervalMs: number;
  decayIntervalMs: number;
  queuePollIntervalMs: number;
  candidatePoolSize: number;
  graphExpansionDepth: number;
  llm: {
    enabled: boolean;
    provider: "openai_compatible" | "none";
    endpoint: string;
    apiKey: string;
    model: string;
    temperature: number;
  };
}

export const defaultConfig: EngineConfig = {
  dbPath: Bun.env.MEMORY_DB_PATH ?? "./data/memory.db",
  shortTermBufferSize: Number(Bun.env.MEMORY_SHORT_TERM_BUFFER_SIZE ?? 20),
  shortTermSummaryMessages: Number(Bun.env.MEMORY_SHORT_TERM_SUMMARY_MESSAGES ?? 12),
  workingMemorySize: Number(Bun.env.MEMORY_WORKING_SIZE ?? 7),
  embeddingDimensions: Number(Bun.env.MEMORY_EMBEDDING_DIMS ?? 192),
  decayHalfLifeHours: Number(Bun.env.MEMORY_DECAY_HALF_LIFE_HOURS ?? 48),
  minStrength: Number(Bun.env.MEMORY_MIN_STRENGTH ?? 0.05),
  archiveStrengthThreshold: Number(Bun.env.MEMORY_ARCHIVE_THRESHOLD ?? 0.08),
  consolidateIntervalMs: Number(Bun.env.MEMORY_CONSOLIDATE_INTERVAL_MS ?? 60_000),
  decayIntervalMs: Number(Bun.env.MEMORY_DECAY_INTERVAL_MS ?? 120_000),
  queuePollIntervalMs: Number(Bun.env.MEMORY_QUEUE_POLL_MS ?? 2_000),
  candidatePoolSize: Number(Bun.env.MEMORY_CANDIDATE_POOL_SIZE ?? 64),
  graphExpansionDepth: Number(Bun.env.MEMORY_GRAPH_EXPANSION_DEPTH ?? 2),
  llm: {
    enabled: (Bun.env.MEMORY_LLM_ENABLED ?? "false") === "true",
    provider:
      (Bun.env.MEMORY_LLM_PROVIDER as EngineConfig["llm"]["provider"] | undefined) ??
      "openai_compatible",
    endpoint: Bun.env.MEMORY_LLM_ENDPOINT ?? "https://api.openai.com/v1/chat/completions",
    apiKey: Bun.env.MEMORY_LLM_API_KEY ?? "",
    model: Bun.env.MEMORY_LLM_MODEL ?? "gpt-4.1-mini",
    temperature: Number(Bun.env.MEMORY_LLM_TEMPERATURE ?? 0.1)
  }
};

export const withConfig = (overrides?: Partial<EngineConfig>): EngineConfig => {
  if (!overrides) {
    return defaultConfig;
  }

  return {
    ...defaultConfig,
    ...overrides,
    llm: {
      ...defaultConfig.llm,
      ...(overrides.llm ?? {})
    }
  };
};
