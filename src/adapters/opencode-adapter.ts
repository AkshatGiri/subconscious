import { BaseMemoryAdapter } from "./base-adapter";
import { MemoryEngine } from "../core/memory-engine";

export class OpenCodeMemoryAdapter extends BaseMemoryAdapter {
  constructor(engine: MemoryEngine) {
    super(engine);
  }

  async beforePrompt(prompt: string, sessionId: string): Promise<string> {
    return this.onBeforeAgentRun(prompt, { sessionId });
  }

  async afterMessages(
    sessionId: string,
    messages: Array<{ role: "user" | "assistant" | "system" | "tool" | "other"; content: string }>
  ): Promise<void> {
    await this.onAfterAgentRun(
      messages.map((message) => ({
        sessionId,
        role: message.role,
        content: message.content
      })),
      { sessionId }
    );
  }
}
