import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { MemoryEngine } from "../src/core/memory-engine";
import type { EngineConfig } from "../src/config";

interface Harness {
  engine: MemoryEngine;
  dbPath: string;
}

const harnesses: Harness[] = [];

const createHarness = (overrides?: Partial<EngineConfig>): Harness => {
  const dbPath = `./data/test-${crypto.randomUUID()}.db`;
  const baseLlm: EngineConfig["llm"] = {
    enabled: false,
    provider: "none",
    endpoint: "",
    apiKey: "",
    model: "",
    temperature: 0
  };

  const base: Partial<EngineConfig> = {
    queuePollIntervalMs: 10,
    consolidateIntervalMs: 999_999_999,
    decayIntervalMs: 999_999_999
  };

  const engine = new MemoryEngine({
    dbPath,
    ...base,
    ...overrides,
    llm: {
      ...baseLlm,
      ...(overrides?.llm ?? {})
    }
  });

  const harness = { engine, dbPath };
  harnesses.push(harness);
  return harness;
};

const cleanupDb = (dbPath: string): void => {
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
};

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) {
      continue;
    }

    await harness.engine.shutdown();
    cleanupDb(harness.dbPath);
  }
});

describe("MemoryEngine", () => {
  test("recalls ingested facts", async () => {
    const { engine } = createHarness();

    await engine.ingest({
      kind: "fact",
      fact: {
        title: "Runtime Preference",
        type: "semantic",
        content: "User prefers Bun runtime over Node.js.",
        topics: ["bun", "runtime"],
        categories: ["preference"],
        confidence: 0.95
      }
    });

    const recalled = await engine.recall("What runtime does the user prefer?", {
      sessionId: "session-a"
    });

    expect(recalled.items.length).toBeGreaterThan(0);
    expect(recalled.context.toLowerCase()).toContain("bun");
  });

  test("extracts memory from conversation and traces provenance", async () => {
    const { engine } = createHarness();

    const ingest = await engine.ingest({
      kind: "conversation",
      messages: [
        {
          sessionId: "session-trace",
          role: "user",
          content: "I prefer Bun for backend tooling."
        },
        {
          sessionId: "session-trace",
          role: "assistant",
          content: "Noted. We also debugged an auth token issue yesterday and fixed it."
        }
      ]
    });

    await Bun.sleep(120);

    const recalled = await engine.recall("what does the user prefer", {
      sessionId: "session-trace"
    });

    expect(recalled.items.length).toBeGreaterThan(0);

    const memoryId = recalled.items[0]?.memory.id;
    expect(memoryId).toBeDefined();

    const trace = engine.trace(String(memoryId));
    expect(trace).not.toBeNull();
    expect(trace?.conversation.length).toBeGreaterThan(0);

    const allText = trace?.conversation.map((entry) => entry.content).join(" ").toLowerCase() ?? "";
    expect(allText).toContain("prefer bun");

    expect(ingest.conversationEntryIds.length).toBe(2);
  });

  test("handles contradictions by superseding old memory", async () => {
    const { engine } = createHarness();

    await engine.ingest({
      kind: "fact",
      fact: {
        title: "Database Fact",
        type: "semantic",
        content: "Project uses PostgreSQL for production data storage.",
        topics: ["database", "postgresql"],
        categories: ["fact"]
      }
    });

    await engine.ingest({
      kind: "fact",
      fact: {
        title: "Database Update",
        type: "semantic",
        content: "Project does not use PostgreSQL for production data storage.",
        topics: ["database", "postgresql"],
        categories: ["fact"]
      }
    });

    const status = engine.status();
    const longTerm = engine.search("postgresql", { layer: "long_term", limit: 10 });
    const hasContradictionEdge = longTerm.some((result) => {
      const memory = engine.get(result.id);
      return memory?.edges.some((edge) => edge.type === "contradicts" || edge.type === "supersedes");
    });

    expect(status.memoryCountsByStatus.archived > 0 || hasContradictionEdge).toBe(true);
  });

  test("consolidates duplicate memories", async () => {
    const { engine } = createHarness();

    await engine.ingest({
      kind: "fact",
      fact: {
        type: "semantic",
        title: "Deploy Workflow A",
        content: "Deploy process: test -> build -> push -> verify.",
        topics: ["deploy", "workflow"],
        categories: ["workflow"]
      }
    });

    await engine.ingest({
      kind: "fact",
      fact: {
        type: "semantic",
        title: "Deploy Workflow B",
        content: "Deploy process: test -> build -> push -> verify.",
        topics: ["deploy", "workflow"],
        categories: ["workflow"]
      }
    });

    const report = await engine.consolidate();
    expect(report.merged).toBeGreaterThanOrEqual(1);
  });

  test("decays score without auto-archive and strongly refreshes on recall", async () => {
    const { engine } = createHarness({
      decayIntervalMs: 20,
      decayHalfLifeHours: 0.00003,
      decayCurveShape: 1.35,
      autoArchiveOnDecay: false,
      recallRefreshBaseBoost: 0.14,
      recallRefreshMaxBoost: 0.42
    });

    const ingest = await engine.ingest({
      kind: "fact",
      fact: {
        title: "Refresh Test",
        type: "semantic",
        content: "User prefers Bun for backend tooling and workflows.",
        topics: ["bun", "backend"],
        categories: ["preference"],
        confidence: 0.95
      }
    });

    const memoryId = ingest.extractedMemoryIds[0];
    expect(memoryId).toBeDefined();

    await Bun.sleep(260);

    const before = engine.get(String(memoryId));
    expect(before?.memory.status).toBe("active");
    const beforeStrength = before?.memory.strength ?? 0;

    await engine.recall("what runtime does the user prefer", {
      sessionId: "refresh-session"
    });

    const after = engine.get(String(memoryId));
    expect(after?.memory.status).toBe("active");
    expect(after?.memory.strength ?? 0).toBeGreaterThan(beforeStrength + 0.1);
  });
});
