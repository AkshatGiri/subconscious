import { MemoryEngine } from "../core/memory-engine";
import { BaseMemoryAdapter } from "../adapters/base-adapter";

export interface RestAdapterOptions {
  host?: string;
  port?: number;
  cors?: boolean;
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });

const withCors = (response: Response): Response => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return response;
};

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw) as Record<string, unknown>;
};

export class RestMemoryAdapter {
  private readonly adapter: BaseMemoryAdapter;

  constructor(private readonly engine: MemoryEngine) {
    this.adapter = new BaseMemoryAdapter(engine);
  }

  start(options?: RestAdapterOptions): Bun.Server<unknown> {
    const host = options?.host ?? "0.0.0.0";
    const port = options?.port ?? Number(Bun.env.PORT ?? 8787);
    const cors = options?.cors ?? true;

    return Bun.serve({
      hostname: host,
      port,
      fetch: async (request) => {
        if (request.method === "OPTIONS") {
          const response = new Response(null, { status: 204 });
          return cors ? withCors(response) : response;
        }

        const url = new URL(request.url);

        try {
          const response = await this.route(request, url);
          return cors ? withCors(response) : response;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          const response = json({ error: message }, 500);
          return cors ? withCors(response) : response;
        }
      }
    });
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/health") {
      return json({ ok: true, status: this.engine.status() });
    }

    if (request.method === "GET" && pathname === "/tools") {
      return json(this.adapter.getTools());
    }

    if (request.method === "GET" && pathname === "/status") {
      return json(this.engine.status());
    }

    if (request.method === "POST" && pathname === "/ingest/conversation") {
      const body = await readJson(request);
      const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? [];
      const result = await this.engine.ingest({
        kind: "conversation",
        messages: messages.map((message) => ({
          sessionId: String(message.sessionId ?? "default"),
          role: (message.role as "user" | "assistant" | "system" | "tool" | "other") ?? "user",
          content: String(message.content ?? ""),
          channel: message.channel ? String(message.channel) : undefined,
          agent: message.agent ? String(message.agent) : undefined,
          speaker: message.speaker ? String(message.speaker) : undefined,
          timestamp: message.timestamp ? Number(message.timestamp) : undefined,
          metadata: (message.metadata as Record<string, unknown> | undefined) ?? {}
        }))
      });

      return json(result);
    }

    if (request.method === "POST" && pathname === "/ingest/document") {
      const body = await readJson(request);
      const result = await this.engine.ingest({
        kind: "document",
        document: {
          id: body.id ? String(body.id) : undefined,
          sourceId: body.sourceId ? String(body.sourceId) : undefined,
          title: body.title ? String(body.title) : undefined,
          content: String(body.content ?? ""),
          timestamp: body.timestamp ? Number(body.timestamp) : undefined,
          metadata: (body.metadata as Record<string, unknown> | undefined) ?? {}
        }
      });

      return json(result);
    }

    if (request.method === "POST" && pathname === "/ingest/fact") {
      const body = await readJson(request);
      const result = await this.engine.ingest({
        kind: "fact",
        fact: {
          id: body.id ? String(body.id) : undefined,
          type: body.type
            ? (String(body.type) as "semantic" | "episodic" | "procedural")
            : undefined,
          title: body.title ? String(body.title) : undefined,
          content: String(body.content ?? ""),
          topics: Array.isArray(body.topics) ? body.topics.map(String) : undefined,
          categories: Array.isArray(body.categories) ? body.categories.map(String) : undefined,
          confidence: body.confidence ? Number(body.confidence) : undefined,
          timestamp: body.timestamp ? Number(body.timestamp) : undefined,
          metadata: (body.metadata as Record<string, unknown> | undefined) ?? {},
          sourceConversationEntryIds: Array.isArray(body.sourceConversationEntryIds)
            ? body.sourceConversationEntryIds.map(String)
            : undefined
        }
      });

      return json(result);
    }

    if (request.method === "POST" && pathname === "/recall") {
      const body = await readJson(request);
      const result = await this.engine.recall(String(body.query ?? ""), {
        sessionId: body.sessionId ? String(body.sessionId) : undefined,
        limit: body.limit ? Number(body.limit) : undefined,
        detailLevel:
          body.detailLevel === "full" || body.detailLevel === "summary"
            ? (body.detailLevel as "summary" | "full")
            : "summary"
      });

      return json(result);
    }

    if (request.method === "GET" && pathname === "/search") {
      const query = String(url.searchParams.get("q") ?? "");
      const layer =
        (url.searchParams.get("layer") as "all" | "conversation" | "short_term" | "long_term" | null) ??
        "all";
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;

      return json(
        this.engine.search(query, {
          layer,
          sessionId,
          limit
        })
      );
    }

    if (request.method === "GET" && pathname.startsWith("/memory/")) {
      const id = pathname.replace("/memory/", "");
      const result = this.engine.get(id);
      return result ? json(result) : json({ error: "Not found" }, 404);
    }

    if (request.method === "GET" && pathname.startsWith("/trace/")) {
      const id = pathname.replace("/trace/", "");
      const result = this.engine.trace(id);
      return result ? json(result) : json({ error: "Not found" }, 404);
    }

    if (request.method === "POST" && pathname === "/consolidate") {
      return json(await this.engine.consolidate());
    }

    if (request.method === "POST" && pathname.startsWith("/forget/")) {
      const id = pathname.replace("/forget/", "");
      return json({ success: this.engine.forget(id) });
    }

    if (request.method === "POST" && pathname.startsWith("/archive/")) {
      const id = pathname.replace("/archive/", "");
      return json({ success: this.engine.archive(id) });
    }

    if (request.method === "POST" && pathname.startsWith("/reinforce/")) {
      const id = pathname.replace("/reinforce/", "");
      const body = await readJson(request);
      return json({
        success: this.engine.reinforce(id, body.amount ? Number(body.amount) : undefined)
      });
    }

    if (request.method === "POST" && pathname === "/associate") {
      const body = await readJson(request);
      return json({
        success: this.engine.associate(
          String(body.a ?? ""),
          String(body.b ?? ""),
          String(body.edge ?? "related_to") as
            | "related_to"
            | "caused_by"
            | "led_to"
            | "supersedes"
            | "reinforces"
            | "contradicts"
            | "sourced_from"
            | "part_of",
          body.weight ? Number(body.weight) : undefined
        )
      });
    }

    return json({ error: "Not found" }, 404);
  }
}
