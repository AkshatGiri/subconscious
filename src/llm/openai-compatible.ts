import type {
  ConversationMessage,
  LLMContradictionResult,
  LLMExtractionResult,
  MemoryNode,
  SubconsciousLLM
} from "../types";

interface OpenAICompatibleOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
}

const extractJson = (text: string): string | null => {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1).trim();
  }

  return null;
};

export class OpenAICompatibleLLM implements SubconsciousLLM {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  private async complete(system: string, user: string): Promise<string | null> {
    if (!this.options.apiKey) {
      return null;
    }

    const response = await fetch(this.options.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: this.options.temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    return payload.choices?.[0]?.message?.content ?? null;
  }

  async extract(payload: {
    messages: ConversationMessage[];
    currentSummary: string;
  }): Promise<LLMExtractionResult | null> {
    const system =
      "You are a memory extraction model. Extract semantic, episodic, and procedural memories. Return valid JSON.";

    const user = JSON.stringify(
      {
        summary: payload.currentSummary,
        messages: payload.messages,
        schema: {
          memories: [
            {
              type: "semantic|episodic|procedural",
              title: "short title",
              content: "atomic memory statement",
              topics: ["topic"],
              categories: ["fact|decision|event|workflow|preference|entity"],
              confidence: 0.0
            }
          ],
          summary: "rolling summary"
        }
      },
      null,
      2
    );

    const output = await this.complete(system, user);
    if (!output) {
      return null;
    }

    const raw = extractJson(output);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as LLMExtractionResult;
      if (!Array.isArray(parsed.memories)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async summarize(payload: {
    previousSummary: string;
    messages: ConversationMessage[];
  }): Promise<string | null> {
    const system =
      "You maintain a concise rolling short-term summary of conversation context. Return JSON with a summary field.";

    const user = JSON.stringify(
      {
        previousSummary: payload.previousSummary,
        messages: payload.messages,
        maxLength: 1400
      },
      null,
      2
    );

    const output = await this.complete(system, user);
    if (!output) {
      return null;
    }

    const raw = extractJson(output);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as { summary?: string };
      return parsed.summary?.trim() || null;
    } catch {
      return null;
    }
  }

  async resolveContradiction(payload: {
    existing: MemoryNode;
    incoming: MemoryNode;
  }): Promise<LLMContradictionResult | null> {
    const system =
      "Decide if incoming memory supersedes existing memory. Return JSON action: supersede, keep_both, or flag.";

    const user = JSON.stringify(payload, null, 2);
    const output = await this.complete(system, user);
    if (!output) {
      return null;
    }

    const raw = extractJson(output);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as LLMContradictionResult;
      if (!["supersede", "keep_both", "flag"].includes(parsed.action)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
