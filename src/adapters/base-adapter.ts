import type {
  AdapterMessage,
  AdapterSession,
  ConversationMessage,
  MemoryAdapter,
  RecallResult,
  ToolDefinition
} from "../types";
import { MemoryEngine } from "../core/memory-engine";

export class BaseMemoryAdapter implements MemoryAdapter {
  constructor(protected readonly engine: MemoryEngine) {}

  async onConversationMessage(msg: AdapterMessage): Promise<void> {
    await this.engine.ingest({
      kind: "conversation",
      messages: [
        {
          sessionId: msg.sessionId,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          channel: msg.channel,
          agent: msg.agent,
          speaker: msg.speaker,
          metadata: msg.metadata
        }
      ]
    });
  }

  async onSessionStart(session: AdapterSession): Promise<string> {
    const query = session.initialPrompt ?? "session start context";
    const recalled = await this.engine.recall(query, {
      sessionId: session.sessionId,
      detailLevel: "summary"
    });

    const recentMessages = this.engine.getRecentConversation({
      sessionId: session.sessionId,
      limit: 6,
      fallbackGlobal: true
    });
    const sensoryTail = this.formatSensoryTail(recentMessages);

    return [recalled.context, sensoryTail]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  async onBeforeAgentRun(prompt: string, session: AdapterSession): Promise<string> {
    const recalled = await this.engine.recall(prompt, {
      sessionId: session.sessionId,
      detailLevel: "summary"
    });

    return recalled.context;
  }

  async onAfterAgentRun(messages: AdapterMessage[], _session: AdapterSession): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    await this.engine.ingest({
      kind: "conversation",
      messages: messages.map((msg) => ({
        sessionId: msg.sessionId,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        channel: msg.channel,
        agent: msg.agent,
        speaker: msg.speaker,
        metadata: msg.metadata
      }))
    });
  }

  async onContextOverflow(_session: AdapterSession): Promise<void> {
    await this.engine.consolidate();
  }

  async onSessionEnd(_session: AdapterSession): Promise<void> {
    await this.engine.consolidate();
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: "memory_recall",
        description:
          "Recall top working-memory items for a query using relevance, recency, strength, and graph links.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            sessionId: { type: "string" },
            limit: { type: "number" },
            includeEmbedding: { type: "boolean" }
          },
          required: ["query"]
        }
      },
      {
        name: "memory_search",
        description:
          "Search across memory layers (conversation log, short-term summary, long-term graph).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            layer: { type: "string", enum: ["all", "conversation", "short_term", "long_term"] },
            sessionId: { type: "string" },
            limit: { type: "number" }
          },
          required: ["query"]
        }
      },
      {
        name: "memory_get",
        description: "Get memory node details and local graph neighborhood.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" }
          },
          required: ["memoryId"]
        }
      },
      {
        name: "memory_trace",
        description: "Trace memory provenance to sourced conversation entries.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" }
          },
          required: ["memoryId"]
        }
      },
      {
        name: "memory_status",
        description: "Return health metrics and memory counts by type/strength.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "memory_consolidate",
        description: "Trigger an immediate consolidation cycle.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "memory_associate",
        description: "Create an explicit edge between two memories.",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            edge: {
              type: "string",
              enum: [
                "related_to",
                "caused_by",
                "led_to",
                "supersedes",
                "reinforces",
                "contradicts",
                "sourced_from",
                "part_of"
              ]
            },
            weight: { type: "number" }
          },
          required: ["a", "b", "edge"]
        }
      },
      {
        name: "memory_reinforce",
        description: "Manually strengthen a memory node.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            amount: { type: "number" }
          },
          required: ["memoryId"]
        }
      },
      {
        name: "memory_archive",
        description: "Manually archive a memory node.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" }
          },
          required: ["memoryId"]
        }
      },
      {
        name: "memory_forget",
        description: "Mark a memory for forgetting (status set to forgotten).",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" }
          },
          required: ["memoryId"]
        }
      }
    ];
  }

  async getWorkingMemory(query: string, session: AdapterSession): Promise<string> {
    const recalled = await this.engine.recall(query, {
      sessionId: session.sessionId,
      detailLevel: "summary"
    });

    return recalled.context;
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "memory_recall": {
        const result = await this.engine.recall(String(args.query ?? ""), {
          sessionId: args.sessionId ? String(args.sessionId) : undefined,
          limit: args.limit ? Number(args.limit) : undefined,
          detailLevel: "summary"
        });

        const includeEmbedding = args.includeEmbedding === true;
        return this.toToolRecallResult(result, includeEmbedding);
      }
      case "memory_search":
        return this.engine.search(String(args.query ?? ""), {
          layer: (args.layer as "all" | "conversation" | "short_term" | "long_term" | undefined) ??
            "all",
          sessionId: args.sessionId ? String(args.sessionId) : undefined,
          limit: args.limit ? Number(args.limit) : undefined
        });
      case "memory_get":
        return this.engine.get(String(args.memoryId ?? ""));
      case "memory_trace":
        return this.engine.trace(String(args.memoryId ?? ""));
      case "memory_status":
        return this.engine.status();
      case "memory_consolidate":
        return this.engine.consolidate();
      case "memory_associate":
        return {
          success: this.engine.associate(
            String(args.a ?? ""),
            String(args.b ?? ""),
            String(args.edge ?? "related_to") as Parameters<MemoryEngine["associate"]>[2],
            args.weight ? Number(args.weight) : undefined
          )
        };
      case "memory_reinforce":
        return {
          success: this.engine.reinforce(
            String(args.memoryId ?? ""),
            args.amount ? Number(args.amount) : undefined
          )
        };
      case "memory_archive":
        return {
          success: this.engine.archive(String(args.memoryId ?? ""))
        };
      case "memory_forget":
        return {
          success: this.engine.forget(String(args.memoryId ?? ""))
        };
      default:
        throw new Error(`Unknown memory tool: ${name}`);
    }
  }

  private formatSensoryTail(messages: ConversationMessage[]): string {
    const lines = messages
      .map((message) => {
        const content = message.content.trim().replace(/\s+/g, " ");
        if (!content) {
          return null;
        }

        const clipped = content.length > 220 ? `${content.slice(0, 220)}...` : content;
        return `- ${message.role}: ${clipped}`;
      })
      .filter((line): line is string => Boolean(line));

    if (lines.length === 0) {
      return "";
    }

    return `Recent Sensory Tail:\n${lines.join("\n")}`;
  }

  private toToolRecallResult(result: RecallResult, includeEmbedding: boolean): unknown {
    if (includeEmbedding) {
      return result;
    }

    const payload = structuredClone(result) as unknown as Record<string, unknown>;
    const items = Array.isArray(payload.items) ? payload.items : [];

    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const memory = (item as { memory?: unknown }).memory;
      if (!memory || typeof memory !== "object") {
        continue;
      }

      delete (memory as { embedding?: unknown }).embedding;
    }

    return payload;
  }
}
