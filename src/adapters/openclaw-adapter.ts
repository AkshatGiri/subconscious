import { BaseMemoryAdapter } from "./base-adapter";
import { MemoryEngine } from "../core/memory-engine";
import type { AdapterMessage, AdapterSession } from "../types";

export interface OpenClawToolApi {
  registerTool(definition: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }): void;
}

export interface OpenClawMessagePayload {
  sessionId?: string;
  role: "user" | "assistant" | "system" | "tool" | "other";
  content: string;
  timestamp?: number;
  channel?: string;
  agent?: string;
  speaker?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenClawSessionPayload {
  sessionId: string;
  channel?: string;
  agent?: string;
  initialPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenClawPromptPayload {
  session: OpenClawSessionPayload;
  prompt: string;
}

export interface OpenClawAfterRunPayload {
  session: OpenClawSessionPayload;
  messages: OpenClawMessagePayload[];
}

export interface OpenClawLifecycleApi {
  onConversationMessage?: (
    handler: (payload: OpenClawMessagePayload) => Promise<void> | void
  ) => void;
  onSessionStart?: (
    handler: (payload: OpenClawSessionPayload) => Promise<string | void> | string | void
  ) => void;
  onBeforeAgentRun?: (
    handler: (payload: OpenClawPromptPayload) => Promise<string | void> | string | void
  ) => void;
  onAfterAgentRun?: (
    handler: (payload: OpenClawAfterRunPayload) => Promise<void> | void
  ) => void;
  onContextOverflow?: (
    handler: (payload: OpenClawSessionPayload) => Promise<void> | void
  ) => void;
  onSessionEnd?: (
    handler: (payload: OpenClawSessionPayload) => Promise<void> | void
  ) => void;
  registerHook?: (
    name:
      | "conversation_message"
      | "session_start"
      | "before_agent_run"
      | "after_agent_run"
      | "context_overflow"
      | "session_end",
    handler: (...args: unknown[]) => unknown
  ) => void;
}

export interface OpenClawApi extends OpenClawToolApi, OpenClawLifecycleApi {}

export interface OpenClawRegisterOptions {
  includeTools?: boolean;
  includeHooks?: boolean;
}

export class OpenClawMemoryAdapter extends BaseMemoryAdapter {
  constructor(engine: MemoryEngine) {
    super(engine);
  }

  registerWith(api: OpenClawApi, options: OpenClawRegisterOptions = {}): void {
    const includeTools = options.includeTools ?? true;
    const includeHooks = options.includeHooks ?? true;

    if (includeTools) {
      this.registerTools(api);
    }

    if (includeHooks) {
      this.registerHooks(api);
    }
  }

  registerTools(api: OpenClawToolApi): void {
    for (const tool of this.getTools()) {
      api.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (args) => this.executeTool(tool.name, args)
      });
    }
  }

  registerHooks(api: OpenClawLifecycleApi): void {
    const hooks = this.createHookHandlers();

    if (api.registerHook) {
      api.registerHook("conversation_message", (payload) =>
        hooks.onConversationMessage(payload as OpenClawMessagePayload)
      );
      api.registerHook("session_start", (payload) =>
        hooks.onSessionStart(payload as OpenClawSessionPayload)
      );
      api.registerHook("before_agent_run", (payload) =>
        hooks.onBeforeAgentRun(payload as OpenClawPromptPayload)
      );
      api.registerHook("after_agent_run", (payload) =>
        hooks.onAfterAgentRun(payload as OpenClawAfterRunPayload)
      );
      api.registerHook("context_overflow", (payload) =>
        hooks.onContextOverflow(payload as OpenClawSessionPayload)
      );
      api.registerHook("session_end", (payload) =>
        hooks.onSessionEnd(payload as OpenClawSessionPayload)
      );
      return;
    }

    api.onConversationMessage?.(hooks.onConversationMessage);
    api.onSessionStart?.(hooks.onSessionStart);
    api.onBeforeAgentRun?.(hooks.onBeforeAgentRun);
    api.onAfterAgentRun?.(hooks.onAfterAgentRun);
    api.onContextOverflow?.(hooks.onContextOverflow);
    api.onSessionEnd?.(hooks.onSessionEnd);
  }

  createHookHandlers(): {
    onConversationMessage: (payload: OpenClawMessagePayload) => Promise<void>;
    onSessionStart: (payload: OpenClawSessionPayload) => Promise<string>;
    onBeforeAgentRun: (payload: OpenClawPromptPayload) => Promise<string>;
    onAfterAgentRun: (payload: OpenClawAfterRunPayload) => Promise<void>;
    onContextOverflow: (payload: OpenClawSessionPayload) => Promise<void>;
    onSessionEnd: (payload: OpenClawSessionPayload) => Promise<void>;
  } {
    return {
      onConversationMessage: async (payload) => {
        const message = this.toAdapterMessage(payload);
        await this.onConversationMessage(message);
      },
      onSessionStart: async (payload) => this.onSessionStart(this.toAdapterSession(payload)),
      onBeforeAgentRun: async (payload) =>
        this.onBeforeAgentRun(payload.prompt, this.toAdapterSession(payload.session)),
      onAfterAgentRun: async (payload) => {
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

  private toAdapterSession(payload: OpenClawSessionPayload): AdapterSession {
    return {
      sessionId: payload.sessionId,
      channel: payload.channel,
      agent: payload.agent,
      initialPrompt: payload.initialPrompt,
      metadata: payload.metadata
    };
  }

  private toAdapterMessage(payload: OpenClawMessagePayload): AdapterMessage {
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
