import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryEngine } from "../src/core/memory-engine";
import {
  OpenClawMemoryAdapter,
  type OpenClawAfterRunPayload,
  type OpenClawMessagePayload,
  type OpenClawPromptPayload,
  type OpenClawSessionPayload,
  type OpenClawToolApi
} from "../src/adapters/openclaw-adapter";

interface Harness {
  engine: MemoryEngine;
  dbPath: string;
}

const harnesses: Harness[] = [];

const createHarness = (): Harness => {
  const dbPath = `./data/test-openclaw-${crypto.randomUUID()}.db`;
  const engine = new MemoryEngine({
    dbPath,
    queuePollIntervalMs: 10,
    consolidateIntervalMs: 999_999_999,
    decayIntervalMs: 999_999_999,
    llm: {
      enabled: false,
      provider: "none",
      endpoint: "",
      apiKey: "",
      model: "",
      temperature: 0
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

describe("OpenClawMemoryAdapter", () => {
  test("registers tools and callback-style lifecycle hooks", async () => {
    const { engine } = createHarness();
    const adapter = new OpenClawMemoryAdapter(engine);

    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    }> = [];

    let onConversationMessage:
      | ((payload: OpenClawMessagePayload) => Promise<void> | void)
      | undefined;
    let onSessionStart:
      | ((payload: OpenClawSessionPayload) => Promise<string | void> | string | void)
      | undefined;
    let onBeforeAgentRun:
      | ((payload: OpenClawPromptPayload) => Promise<string | void> | string | void)
      | undefined;
    let onAfterAgentRun:
      | ((payload: OpenClawAfterRunPayload) => Promise<void> | void)
      | undefined;
    let onContextOverflow:
      | ((payload: OpenClawSessionPayload) => Promise<void> | void)
      | undefined;
    let onSessionEnd:
      | ((payload: OpenClawSessionPayload) => Promise<void> | void)
      | undefined;

    adapter.registerWith({
      registerTool: (definition) => tools.push(definition),
      onConversationMessage: (handler) => {
        onConversationMessage = handler;
      },
      onSessionStart: (handler) => {
        onSessionStart = handler;
      },
      onBeforeAgentRun: (handler) => {
        onBeforeAgentRun = handler;
      },
      onAfterAgentRun: (handler) => {
        onAfterAgentRun = handler;
      },
      onContextOverflow: (handler) => {
        onContextOverflow = handler;
      },
      onSessionEnd: (handler) => {
        onSessionEnd = handler;
      }
    });

    expect(tools.length).toBe(adapter.getTools().length);
    expect(onConversationMessage).toBeDefined();
    expect(onSessionStart).toBeDefined();
    expect(onBeforeAgentRun).toBeDefined();
    expect(onAfterAgentRun).toBeDefined();
    expect(onContextOverflow).toBeDefined();
    expect(onSessionEnd).toBeDefined();

    const sessionStartContext = await onSessionStart?.({
      sessionId: "openclaw-callbacks",
      initialPrompt: "what do we know"
    });
    expect(typeof sessionStartContext).toBe("string");

    await onConversationMessage?.({
      sessionId: "openclaw-callbacks",
      role: "user",
      content: "I prefer Bun for backend tooling."
    });

    const beforeContext = await onBeforeAgentRun?.({
      session: {
        sessionId: "openclaw-callbacks"
      },
      prompt: "what is my preference"
    });
    expect(typeof beforeContext).toBe("string");

    await onAfterAgentRun?.({
      session: {
        sessionId: "openclaw-callbacks"
      },
      messages: [
        {
          role: "assistant",
          content: "Deploy process is test -> build -> push -> verify."
        }
      ]
    });

    await onContextOverflow?.({ sessionId: "openclaw-callbacks" });
    await onSessionEnd?.({ sessionId: "openclaw-callbacks" });

    const recall = await engine.recall("what is the user preference and deploy process", {
      sessionId: "openclaw-callbacks"
    });
    expect(recall.items.length).toBeGreaterThan(0);
  });

  test("supports registerHook-style lifecycle wiring", async () => {
    const { engine } = createHarness();
    const adapter = new OpenClawMemoryAdapter(engine);

    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    let registeredToolCount = 0;

    adapter.registerWith(
      {
        registerTool: () => {
          registeredToolCount += 1;
        },
        registerHook: (name, handler) => {
          hooks.set(name, handler);
        }
      },
      {
        includeTools: false,
        includeHooks: true
      }
    );

    expect(registeredToolCount).toBe(0);
    expect(hooks.size).toBe(6);

    const runHook = async <T>(name: string, payload: T): Promise<unknown> => {
      const hook = hooks.get(name);
      expect(hook).toBeDefined();
      return hook?.(payload);
    };

    await runHook("conversation_message", {
      sessionId: "openclaw-registerhook",
      role: "user",
      content: "I prefer Bun over Node."
    } satisfies OpenClawMessagePayload);

    await runHook("after_agent_run", {
      session: {
        sessionId: "openclaw-registerhook"
      },
      messages: [
        {
          role: "assistant",
          content: "We debugged auth yesterday and fixed stale token issues."
        }
      ]
    } satisfies OpenClawAfterRunPayload);

    const context = await runHook("before_agent_run", {
      session: {
        sessionId: "openclaw-registerhook"
      },
      prompt: "what do we know"
    } satisfies OpenClawPromptPayload);

    expect(typeof context).toBe("string");

    const recall = await engine.recall("what is preferred runtime", {
      sessionId: "openclaw-registerhook"
    });
    expect(recall.items.length).toBeGreaterThan(0);
  });

  test("can register tools only or hooks only", () => {
    const { engine } = createHarness();
    const adapter = new OpenClawMemoryAdapter(engine);

    let toolsOnlyCount = 0;
    adapter.registerWith(
      {
        registerTool: () => {
          toolsOnlyCount += 1;
        }
      } satisfies OpenClawToolApi,
      {
        includeTools: true,
        includeHooks: false
      }
    );

    expect(toolsOnlyCount).toBe(adapter.getTools().length);

    let hooksOnlyCount = 0;
    adapter.registerWith(
      {
        registerTool: () => {
          throw new Error("registerTool should not be called in hooks-only mode");
        },
        registerHook: () => {
          hooksOnlyCount += 1;
        }
      },
      {
        includeTools: false,
        includeHooks: true
      }
    );

    expect(hooksOnlyCount).toBe(6);
  });
});
