import { BaseMemoryAdapter } from "./base-adapter";
import { MemoryEngine } from "../core/memory-engine";

export class CodexMemoryAdapter extends BaseMemoryAdapter {
  constructor(engine: MemoryEngine) {
    super(engine);
  }

  async onPrompt(sessionId: string, prompt: string): Promise<string> {
    return this.onBeforeAgentRun(prompt, { sessionId, channel: "codex" });
  }

  async onTranscript(
    sessionId: string,
    entries: Array<{ role: "user" | "assistant" | "system" | "tool" | "other"; content: string }>
  ): Promise<void> {
    await this.onAfterAgentRun(
      entries.map((entry) => ({
        sessionId,
        role: entry.role,
        content: entry.content,
        channel: "codex"
      })),
      { sessionId, channel: "codex" }
    );
  }
}
