import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryEngine } from "../src/core/memory-engine";
import {
  PiMemoryAdapter,
  type PiExtensionApi,
  type PiExtensionContext,
  type PiExtensionEventName,
  type PiExtensionToolDefinition
} from "../src/adapters/pi-adapter";

interface Harness {
  engine: MemoryEngine;
  dbPath: string;
}

const harnesses: Harness[] = [];

const createHarness = (): Harness => {
  const dbPath = `./data/test-pi-extension-${crypto.randomUUID()}.db`;
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

describe("PiMemoryAdapter (official pi extension API)", () => {
  test("registerWithPiExtension wires official events and tools", async () => {
    const { engine } = createHarness();
    const adapter = new PiMemoryAdapter(engine);

    const handlers = new Map<
      PiExtensionEventName,
      (event: unknown, ctx: PiExtensionContext) => Promise<unknown> | unknown
    >();
    const tools: PiExtensionToolDefinition[] = [];

    const api: PiExtensionApi = {
      on: (event, handler) => {
        handlers.set(event, handler);
      },
      registerTool: (definition) => {
        tools.push(definition);
      }
    };

    adapter.registerWithPiExtension(api);

    expect(tools.length).toBe(adapter.getTools().length);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("session_before_compact")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);

    const ctx: PiExtensionContext = {
      sessionManager: {
        getSessionFile: () => "pi-session-main"
      }
    };

    await adapter.afterResponse("pi-session-main", [
      {
        role: "user",
        content: "I prefer Bun over Node for scripting."
      }
    ]);

    const onSessionStart = handlers.get("session_start");
    const onBeforeAgentStart = handlers.get("before_agent_start");
    const onAgentEnd = handlers.get("agent_end");
    const onBeforeCompact = handlers.get("session_before_compact");
    const onShutdown = handlers.get("session_shutdown");

    expect(onSessionStart).toBeDefined();
    expect(onBeforeAgentStart).toBeDefined();
    expect(onAgentEnd).toBeDefined();
    expect(onBeforeCompact).toBeDefined();
    expect(onShutdown).toBeDefined();

    await onSessionStart?.({}, ctx);

    const beforeResult = (await onBeforeAgentStart?.(
      {
        prompt: "what runtime do I prefer?",
        systemPrompt: "Base system prompt"
      },
      ctx
    )) as { message?: { content?: string } };

    expect(typeof beforeResult?.message?.content).toBe("string");
    expect(beforeResult.message?.content?.length ?? 0).toBeGreaterThan(0);

    await onAgentEnd?.(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Deploy process is test -> build -> push -> verify."
              }
            ]
          }
        ]
      },
      ctx
    );

    await onBeforeCompact?.({}, ctx);
    await onShutdown?.({}, ctx);

    const recall = await engine.recall("deploy process and runtime preference", {
      sessionId: "pi-session-main"
    });
    expect(recall.items.length).toBeGreaterThan(0);
  });

  test("can inject into system prompt mode", async () => {
    const { engine } = createHarness();
    const adapter = new PiMemoryAdapter(engine);

    const handlers = new Map<
      PiExtensionEventName,
      (event: unknown, ctx: PiExtensionContext) => Promise<unknown> | unknown
    >();

    adapter.registerWithPiExtension(
      {
        on: (event, handler) => {
          handlers.set(event, handler);
        },
        registerTool: () => {
          throw new Error("tools should not be registered in lifecycle-only mode");
        }
      },
      {
        includeTools: false,
        includeLifecycle: true,
        injectMode: "system_prompt"
      }
    );

    const ctx: PiExtensionContext = {
      sessionManager: {
        getSessionFile: () => "pi-system-prompt"
      }
    };

    await adapter.afterResponse("pi-system-prompt", [
      {
        role: "user",
        content: "I like concise replies."
      }
    ]);

    await handlers.get("session_start")?.({}, ctx);

    const result = (await handlers.get("before_agent_start")?.(
      {
        prompt: "what style do I prefer?",
        systemPrompt: "You are helpful"
      },
      ctx
    )) as { systemPrompt?: string };

    expect(typeof result.systemPrompt).toBe("string");
    expect(result.systemPrompt?.includes("[Subconscious Memory]"));
  });
});
