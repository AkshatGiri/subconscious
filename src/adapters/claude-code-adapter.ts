import { BaseMemoryAdapter } from "./base-adapter";
import { MemoryEngine } from "../core/memory-engine";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ClaudeCodeMemoryAdapter extends BaseMemoryAdapter {
  constructor(engine: MemoryEngine) {
    super(engine);
  }

  toMcpTools(): McpToolDefinition[] {
    return this.getTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  async handleMcpToolCall(name: string, argumentsJson: string): Promise<unknown> {
    const args = argumentsJson.trim() ? (JSON.parse(argumentsJson) as Record<string, unknown>) : {};
    return this.executeTool(name, args);
  }
}
