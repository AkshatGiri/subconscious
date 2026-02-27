import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryEngine } from "../src/core/memory-engine";
import {
  PiMemoryAdapter,
  type PiAfterResponsePayload,
  type PiMessagePayload,
  type PiPromptPayload,
  type PiSessionPayload,
  type PiToolApi
} from "../src/adapters/pi-adapter";

interface Harness {
  engine: MemoryEngine;
  dbPath: string;
}

const harnesses: Harness[] = [];

const createHarness = (): Harness => {
  const dbPath = `./data/test-pi-${crypto.randomUUID()}.db`;
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

describe("PiMemoryAdapter", () => {
  test("session start context includes recent sensory tail from prior activity", async () => {
    const { engine } = createHarness();
    const adapter = new PiMemoryAdapter(engine);

    await adapter.afterResponse("pi-prior", [
      {
        role: "user",
        content: "My name is Akshat and we were fixing startup context."
      },
      {
        role: "assistant",
        content: "Noted. Next step is to inject recent messages on session start."
      }
    ]);

    const startupContext = await adapter.onSessionStart({
      sessionId: "pi-fresh-session",
      channel: "pi"
    });

    expect(startupContext).toContain("Recent Sensory Tail:");
    expect(startupContext).toContain("inject recent messages on session start");
  });

  test("registers tools and callback-style hooks", async () => {
    const { engine } = createHarness();
    const adapter = new PiMemoryAdapter(engine);

    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    }> = [];

    let onMessage: ((payload: PiMessagePayload) => Promise<void> | void) | undefined;
    let onSessionStart:
      | ((payload: PiSessionPayload) => Promise<string | void> | string | void)
      | undefined;
    let onBeforeResponse:
      | ((payload: PiPromptPayload) => Promise<string | void> | string | void)
      | undefined;
    let onAfterResponse: ((payload: PiAfterResponsePayload) => Promise<void> | void) | undefined;
    let onContextOverflow: ((payload: PiSessionPayload) => Promise<void> | void) | undefined;
    let onSessionEnd: ((payload: PiSessionPayload) => Promise<void> | void) | undefined;

    adapter.registerWith({
      registerTool: (definition) => tools.push(definition),
      onMessage: (handler) => {
        onMessage = handler;
      },
      onSessionStart: (handler) => {
        onSessionStart = handler;
      },
      onBeforeResponse: (handler) => {
        onBeforeResponse = handler;
      },
      onAfterResponse: (handler) => {
        onAfterResponse = handler;
      },
      onContextOverflow: (handler) => {
        onContextOverflow = handler;
      },
      onSessionEnd: (handler) => {
        onSessionEnd = handler;
      }
    });

    expect(tools.length).toBe(adapter.getTools().length);
    expect(onMessage).toBeDefined();
    expect(onSessionStart).toBeDefined();
    expect(onBeforeResponse).toBeDefined();
    expect(onAfterResponse).toBeDefined();
    expect(onContextOverflow).toBeDefined();
    expect(onSessionEnd).toBeDefined();

    const sessionStartContext = await onSessionStart?.({
      sessionId: "pi-callbacks",
      initialPrompt: "what do we know"
    });
    expect(typeof sessionStartContext).toBe("string");

    await onMessage?.({
      sessionId: "pi-callbacks",
      role: "user",
      content: "I prefer Bun for backend tooling."
    });

    const beforeContext = await onBeforeResponse?.({
      session: {
        sessionId: "pi-callbacks"
      },
      prompt: "what is my preference"
    });
    expect(typeof beforeContext).toBe("string");

    await onAfterResponse?.({
      session: {
        sessionId: "pi-callbacks"
      },
      messages: [
        {
          role: "assistant",
          content: "Deploy process is test -> build -> push -> verify."
        }
      ]
    });

    await onContextOverflow?.({ sessionId: "pi-callbacks" });
    await onSessionEnd?.({ sessionId: "pi-callbacks" });

    const recall = await engine.recall("what is the user preference and deploy process", {
      sessionId: "pi-callbacks"
    });
    expect(recall.items.length).toBeGreaterThan(0);
  });

  test("supports registerHook-style lifecycle wiring", async () => {
    const { engine } = createHarness();
    const adapter = new PiMemoryAdapter(engine);

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

    await runHook("message", {
      sessionId: "pi-registerhook",
      role: "user",
      content: "I prefer Bun over Node."
    } satisfies PiMessagePayload);

    await runHook("after_response", {
      session: {
        sessionId: "pi-registerhook"
      },
      messages: [
        {
          role: "assistant",
          content: "We debugged auth yesterday and fixed stale token issues."
        }
      ]
    } satisfies PiAfterResponsePayload);

    const context = await runHook("before_response", {
      session: {
        sessionId: "pi-registerhook"
      },
      prompt: "what do we know"
    } satisfies PiPromptPayload);

    expect(typeof context).toBe("string");

    const recall = await engine.recall("what is preferred runtime", {
      sessionId: "pi-registerhook"
    });
    expect(recall.items.length).toBeGreaterThan(0);
  });

  test("can register tools only or hooks only", () => {
    const { engine } = createHarness();
    const adapter = new PiMemoryAdapter(engine);

    let toolsOnlyCount = 0;
    adapter.registerWith(
      {
        registerTool: () => {
          toolsOnlyCount += 1;
        }
      } satisfies PiToolApi,
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

  test("supports direct helper methods", async () => {
    const { engine } = createHarness();
    const adapter = new PiMemoryAdapter(engine);

    await adapter.afterResponse("pi-direct", [
      {
        role: "user",
        content: "I prefer Bun for scripting."
      }
    ]);

    const context = await adapter.beforeResponse("pi-direct", "what runtime do I prefer?");
    expect(typeof context).toBe("string");

    const recall = await engine.recall("preferred runtime", {
      sessionId: "pi-direct"
    });
    expect(recall.items.length).toBeGreaterThan(0);
  });
});
