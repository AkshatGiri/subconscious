import { BaseMemoryAdapter } from "./base-adapter";
import { MemoryEngine } from "../core/memory-engine";
import type { AdapterMessage, AdapterSession } from "../types";

export interface PiToolApi {
  registerTool(definition: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }): void;
}

export interface PiMessagePayload {
  sessionId?: string;
  role: "user" | "assistant" | "system" | "tool" | "other";
  content: string;
  timestamp?: number;
  channel?: string;
  agent?: string;
  speaker?: string;
  metadata?: Record<string, unknown>;
}

export interface PiSessionPayload {
  sessionId: string;
  channel?: string;
  agent?: string;
  initialPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface PiPromptPayload {
  session: PiSessionPayload;
  prompt: string;
}

export interface PiAfterResponsePayload {
  session: PiSessionPayload;
  messages: PiMessagePayload[];
}

export type PiHookName =
  | "message"
  | "session_start"
  | "before_response"
  | "after_response"
  | "context_overflow"
  | "session_end";

export interface PiLifecycleApi {
  onMessage?: (handler: (payload: PiMessagePayload) => Promise<void> | void) => void;
  onSessionStart?: (
    handler: (payload: PiSessionPayload) => Promise<string | void> | string | void
  ) => void;
  onBeforeResponse?: (
    handler: (payload: PiPromptPayload) => Promise<string | void> | string | void
  ) => void;
  onAfterResponse?: (handler: (payload: PiAfterResponsePayload) => Promise<void> | void) => void;
  onContextOverflow?: (handler: (payload: PiSessionPayload) => Promise<void> | void) => void;
  onSessionEnd?: (handler: (payload: PiSessionPayload) => Promise<void> | void) => void;
  registerHook?: (name: PiHookName, handler: (...args: unknown[]) => unknown) => void;
}

export interface PiApi extends PiToolApi, PiLifecycleApi {}

export interface PiRegisterOptions {
  includeTools?: boolean;
  includeHooks?: boolean;
}

export type PiExtensionEventName =
  | "session_start"
  | "before_agent_start"
  | "agent_end"
  | "session_before_compact"
  | "session_shutdown";

export interface PiExtensionSessionManager {
  getSessionFile(): string | null | undefined;
}

export interface PiExtensionContext {
  sessionManager: PiExtensionSessionManager;
}

export interface PiBeforeAgentStartEvent {
  prompt?: string;
  systemPrompt?: string;
}

export interface PiAgentMessage {
  role?: string;
  timestamp?: number;
  content?: unknown;
}

export interface PiAgentEndEvent {
  messages?: PiAgentMessage[];
}

export interface PiExtensionToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content?: Array<{ type: "text"; text: string }>; details?: unknown }) => void,
    ctx?: unknown
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export interface PiExtensionApi {
  on(
    event: PiExtensionEventName,
    handler: (event: unknown, ctx: PiExtensionContext) => Promise<unknown> | unknown
  ): void;
  registerTool(definition: PiExtensionToolDefinition): void;
}

export interface PiExtensionRegisterOptions {
  includeTools?: boolean;
  includeLifecycle?: boolean;
  injectMode?: "message" | "system_prompt";
  messageDisplay?: boolean;
}

export class PiMemoryAdapter extends BaseMemoryAdapter {
  private readonly sessionStartContext = new Map<string, string>();

  constructor(engine: MemoryEngine) {
    super(engine);
  }

  registerWith(api: PiApi, options: PiRegisterOptions = {}): void {
    const includeTools = options.includeTools ?? true;
    const includeHooks = options.includeHooks ?? true;

    if (includeTools) {
      this.registerTools(api);
    }

    if (includeHooks) {
      this.registerHooks(api);
    }
  }

  registerWithPiExtension(api: PiExtensionApi, options: PiExtensionRegisterOptions = {}): void {
    const includeTools = options.includeTools ?? true;
    const includeLifecycle = options.includeLifecycle ?? true;

    if (includeTools) {
      this.registerPiExtensionTools(api);
    }

    if (includeLifecycle) {
      this.registerPiExtensionLifecycle(api, options);
    }
  }

  registerTools(api: PiToolApi): void {
    for (const tool of this.getTools()) {
      api.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (args) => this.executeTool(tool.name, args)
      });
    }
  }

  registerHooks(api: PiLifecycleApi): void {
    const hooks = this.createHookHandlers();

    if (api.registerHook) {
      api.registerHook("message", (payload) => hooks.onMessage(payload as PiMessagePayload));
      api.registerHook("session_start", (payload) =>
        hooks.onSessionStart(payload as PiSessionPayload)
      );
      api.registerHook("before_response", (payload) =>
        hooks.onBeforeResponse(payload as PiPromptPayload)
      );
      api.registerHook("after_response", (payload) =>
        hooks.onAfterResponse(payload as PiAfterResponsePayload)
      );
      api.registerHook("context_overflow", (payload) =>
        hooks.onContextOverflow(payload as PiSessionPayload)
      );
      api.registerHook("session_end", (payload) => hooks.onSessionEnd(payload as PiSessionPayload));
      return;
    }

    api.onMessage?.(hooks.onMessage);
    api.onSessionStart?.(hooks.onSessionStart);
    api.onBeforeResponse?.(hooks.onBeforeResponse);
    api.onAfterResponse?.(hooks.onAfterResponse);
    api.onContextOverflow?.(hooks.onContextOverflow);
    api.onSessionEnd?.(hooks.onSessionEnd);
  }

  createHookHandlers(): {
    onMessage: (payload: PiMessagePayload) => Promise<void>;
    onSessionStart: (payload: PiSessionPayload) => Promise<string>;
    onBeforeResponse: (payload: PiPromptPayload) => Promise<string>;
    onAfterResponse: (payload: PiAfterResponsePayload) => Promise<void>;
    onContextOverflow: (payload: PiSessionPayload) => Promise<void>;
    onSessionEnd: (payload: PiSessionPayload) => Promise<void>;
  } {
    return {
      onMessage: async (payload) => {
        const message = this.toAdapterMessage(payload);
        await this.onConversationMessage(message);
      },
      onSessionStart: async (payload) => this.onSessionStart(this.toAdapterSession(payload)),
      onBeforeResponse: async (payload) =>
        this.onBeforeAgentRun(payload.prompt, this.toAdapterSession(payload.session)),
      onAfterResponse: async (payload) => {
        const session = this.toAdapterSession(payload.session);
        await this.onAfterAgentRun(
          payload.messages.map((message) =>
            this.toAdapterMessage({
              ...message,
              sessionId: message.sessionId ?? session.sessionId
            })
          ),
          session
        );
      },
      onContextOverflow: async (payload) => this.onContextOverflow(this.toAdapterSession(payload)),
      onSessionEnd: async (payload) => this.onSessionEnd(this.toAdapterSession(payload))
    };
  }

  async beforeResponse(sessionId: string, prompt: string): Promise<string> {
    return this.onBeforeAgentRun(prompt, { sessionId, channel: "pi" });
  }

  async afterResponse(
    sessionId: string,
    messages: Array<{ role: PiMessagePayload["role"]; content: string }>
  ): Promise<void> {
    await this.onAfterAgentRun(
      messages.map((message) => ({
        sessionId,
        role: message.role,
        content: message.content,
        channel: "pi"
      })),
      { sessionId, channel: "pi" }
    );
  }

  private registerPiExtensionTools(api: PiExtensionApi): void {
    for (const tool of this.getTools()) {
      api.registerTool({
        name: tool.name,
        label: this.toToolLabel(tool.name),
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_toolCallId, params) => {
          const result = await this.executeTool(tool.name, (params as Record<string, unknown>) ?? {});
          return {
            content: [{ type: "text", text: this.serializeToolResult(result) }],
            details: {
              result
            }
          };
        }
      });
    }
  }

  private registerPiExtensionLifecycle(
    api: PiExtensionApi,
    options: PiExtensionRegisterOptions
  ): void {
    api.on("session_start", async (_event, ctx) => {
      const session = this.toPiExtensionSession(ctx);
      const context = await this.onSessionStart(session);
      this.sessionStartContext.set(session.sessionId, context);
    });

    api.on("before_agent_start", async (event, ctx) => {
      const typedEvent = (event ?? {}) as PiBeforeAgentStartEvent;
      const session = this.toPiExtensionSession(ctx);
      const prompt =
        typeof typedEvent.prompt === "string" && typedEvent.prompt.trim().length > 0
          ? typedEvent.prompt
          : "pi prompt";

      const runtimeContext = await this.onBeforeAgentRun(prompt, session);
      const startupContext = this.sessionStartContext.get(session.sessionId) ?? "";
      const merged = [startupContext, runtimeContext]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n");

      if (!merged) {
        return undefined;
      }

      if ((options.injectMode ?? "message") === "system_prompt") {
        const systemPrompt =
          typeof typedEvent.systemPrompt === "string" ? typedEvent.systemPrompt : "";
        return {
          systemPrompt: `${systemPrompt}\n\n[Subconscious Memory]\n${merged}`.trim()
        };
      }

      return {
        message: {
          customType: "subconscious-working-memory",
          content: merged,
          display: options.messageDisplay ?? false,
          details: {
            source: "subconscious",
            sessionId: session.sessionId
          }
        }
      };
    });

    api.on("agent_end", async (event, ctx) => {
      const typedEvent = (event ?? {}) as PiAgentEndEvent;
      const session = this.toPiExtensionSession(ctx);
      const messages = this.toAdapterMessagesFromPi(
        Array.isArray(typedEvent.messages) ? typedEvent.messages : [],
        session
      );

      if (messages.length === 0) {
        return;
      }

      await this.onAfterAgentRun(messages, session);
    });

    api.on("session_before_compact", async (_event, ctx) => {
      await this.onContextOverflow(this.toPiExtensionSession(ctx));
    });

    api.on("session_shutdown", async (_event, ctx) => {
      const session = this.toPiExtensionSession(ctx);
      await this.onSessionEnd(session);
      this.sessionStartContext.delete(session.sessionId);
    });
  }

  private toPiExtensionSession(ctx: PiExtensionContext): AdapterSession {
    const rawSessionFile = ctx.sessionManager.getSessionFile();
    const sessionId =
      typeof rawSessionFile === "string" && rawSessionFile.trim().length > 0
        ? rawSessionFile
        : "pi-default";

    return {
      sessionId,
      channel: "pi"
    };
  }

  private toAdapterMessagesFromPi(
    messages: PiAgentMessage[],
    session: AdapterSession
  ): AdapterMessage[] {
    const output: AdapterMessage[] = [];

    for (const message of messages) {
      const role = this.toAdapterRole(message.role);
      const content = this.extractPiMessageContent(message.content);
      if (!content) {
        continue;
      }

      output.push({
        sessionId: session.sessionId,
        role,
        content,
        timestamp: message.timestamp,
        channel: session.channel,
        agent: session.agent
      });
    }

    return output;
  }

  private toAdapterRole(role: string | undefined): AdapterMessage["role"] {
    switch (role) {
      case "user":
      case "assistant":
      case "system":
      case "tool":
      case "other":
        return role;
      default:
        return "other";
    }
  }

  private extractPiMessageContent(content: unknown): string {
    if (typeof content === "string") {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const segments: string[] = [];

    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const block = part as {
        type?: unknown;
        text?: unknown;
      };

      if (block.type === "text" && typeof block.text === "string") {
        segments.push(block.text);
        continue;
      }

      if (typeof block.text === "string") {
        segments.push(block.text);
      }
    }

    return segments.join("\n").trim();
  }

  private toToolLabel(toolName: string): string {
    return toolName
      .replace(/^memory_/, "")
      .split("_")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  private serializeToolResult(result: unknown): string {
    if (typeof result === "string") {
      return result;
    }

    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  private toAdapterSession(payload: PiSessionPayload): AdapterSession {
    return {
      sessionId: payload.sessionId,
      channel: payload.channel,
      agent: payload.agent,
      initialPrompt: payload.initialPrompt,
      metadata: payload.metadata
    };
  }

  private toAdapterMessage(payload: PiMessagePayload): AdapterMessage {
    return {
      sessionId: payload.sessionId ?? "default",
      role: payload.role,
      content: payload.content,
      timestamp: payload.timestamp,
      channel: payload.channel,
      agent: payload.agent,
      speaker: payload.speaker,
      metadata: payload.metadata
    };
  }
}
