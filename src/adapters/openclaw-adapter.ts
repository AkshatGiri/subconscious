import { BaseMemoryAdapter } from "./base-adapter";
import { MemoryEngine } from "../core/memory-engine";

export interface OpenClawToolApi {
  registerTool(definition: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  }): void;
}

export class OpenClawMemoryAdapter extends BaseMemoryAdapter {
  constructor(engine: MemoryEngine) {
    super(engine);
  }

  registerWith(api: OpenClawToolApi): void {
    for (const tool of this.getTools()) {
      api.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (args) => this.executeTool(tool.name, args)
      });
    }
  }
}
