import type {
  ConversationMessage,
  LLMContradictionResult,
  LLMExtractionResult,
  MemoryNode,
  SubconsciousLLM
} from "../types";
import { createLogger } from "../utils/logger";

interface OpenAICompatibleOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
}

type EndpointMode = "chat_completions" | "responses" | "completions";

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
  private readonly logger = createLogger("subconscious-llm", Bun.env.MEMORY_LOG_LEVEL);

  constructor(private readonly options: OpenAICompatibleOptions) {}

  private endpointMode(): EndpointMode {
    if (this.options.endpoint.includes("/responses")) {
      return "responses";
    }

    if (this.options.endpoint.includes("/completions") && !this.options.endpoint.includes("/chat/")) {
      return "completions";
    }

    return "chat_completions";
  }

  private extractResponsesText(payload: unknown): string | null {
    const output = (payload as { output?: unknown })?.output;
    if (!Array.isArray(output)) {
      return null;
    }

    const parts: string[] = [];

    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }

      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }

        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }

    const joined = parts.join("\n").trim();
    return joined || null;
  }

  private extractChatCompletionsText(payload: unknown): string | null {
    return (
      (payload as {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      }).choices?.[0]?.message?.content ?? null
    );
  }

  private extractCompletionsText(payload: unknown): string | null {
    return (
      (payload as {
        choices?: Array<{
          text?: string;
        }>;
      }).choices?.[0]?.text ?? null
    );
  }

  private async complete(system: string, user: string): Promise<string | null> {
    if (!this.options.apiKey) {
      this.logger.warn("skipping LLM call: api key missing");
      return null;
    }

    const mode = this.endpointMode();

    this.logger.debug("sending LLM request", {
      model: this.options.model,
      endpoint: this.options.endpoint,
      mode
    });

    const body =
      mode === "responses"
        ? {
            model: this.options.model,
            temperature: this.options.temperature,
            input: [
              {
                role: "system",
                content: [{ type: "input_text", text: system }]
              },
              {
                role: "user",
                content: [{ type: "input_text", text: user }]
              }
            ]
          }
        : mode === "completions"
          ? {
              model: this.options.model,
              temperature: this.options.temperature,
              prompt: `${system}\n\n${user}`
            }
          : {
              model: this.options.model,
              temperature: this.options.temperature,
              response_format: { type: "json_object" as const },
              messages: [
                { role: "system", content: system },
                { role: "user", content: user }
              ]
            };

    let response: Response;
    try {
      response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      this.logger.warn("LLM request network failure", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }

    const responseText = await response.text();
    let payload: unknown = null;

    try {
      payload = responseText ? (JSON.parse(responseText) as unknown) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      this.logger.warn("LLM request failed", {
        status: response.status,
        statusText: response.statusText,
        body: responseText.slice(0, 500)
      });
      return null;
    }

    const content =
      mode === "responses"
        ? this.extractResponsesText(payload)
        : mode === "completions"
          ? this.extractCompletionsText(payload)
          : this.extractChatCompletionsText(payload);

    this.logger.debug("LLM request completed", {
      hasContent: Boolean(content)
    });

    return content;
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
