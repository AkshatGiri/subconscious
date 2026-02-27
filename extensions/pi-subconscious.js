const LEVEL_WEIGHT = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

const asBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
};

const asLogLevel = (value, fallback = "info") => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(LEVEL_WEIGHT, normalized) ? normalized : fallback;
};

const apiBase = process.env.SUBCONSCIOUS_API_URL ?? "http://127.0.0.1:8787";
const injectMode = process.env.SUBCONSCIOUS_INJECT_MODE === "system_prompt" ? "system_prompt" : "message";
const messageDisplay = asBool(process.env.SUBCONSCIOUS_MESSAGE_DISPLAY, false);
const toolSet = process.env.SUBCONSCIOUS_TOOL_SET === "full" ? "full" : "minimal";
const defaultDetail = process.env.SUBCONSCIOUS_RECALL_DETAIL === "full" ? "full" : "summary";
const logLevel = asLogLevel(process.env.SUBCONSCIOUS_EXT_LOG_LEVEL, "info");

const startupContextBySession = new Map();

const log = (level, message, meta) => {
  if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[logLevel]) {
    return;
  }

  const stamp = new Date().toISOString();
  const prefix = `[${stamp}] [pi-subconscious] [${level}] ${message}`;
  if (meta === undefined) {
    console.log(prefix);
    return;
  }

  try {
    console.log(`${prefix} ${JSON.stringify(meta)}`);
  } catch {
    console.log(`${prefix} ${String(meta)}`);
  }
};

const parseBody = async (response) => {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const request = async (method, path, body) => {
  const url = `${apiBase}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const payload = await parseBody(response);

  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "error" in payload ? payload.error : payload;
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${String(detail ?? "unknown error")}`);
  }

  return payload;
};

const extractSessionId = (ctx) => {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (typeof file === "string" && file.trim().length > 0) {
      return file;
    }
  } catch {
    // no-op
  }

  return "pi-default";
};

const normalizeRole = (role) => {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool" || role === "other") {
    return role;
  }

  return "other";
};

const extractText = (content) => {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const lines = [];

  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }

    if (part.type === "text" && typeof part.text === "string") {
      lines.push(part.text);
      continue;
    }

    if (typeof part.text === "string") {
      lines.push(part.text);
    }
  }

  return lines.join("\n").trim();
};

const formatSensoryTail = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const lines = messages
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }

      const role = normalizeRole(message.role);
      const rawContent = typeof message.content === "string" ? message.content : "";
      const content = rawContent.trim().replace(/\s+/g, " ");
      if (!content) {
        return null;
      }

      const clipped = content.length > 220 ? `${content.slice(0, 220)}...` : content;
      return `- ${role}: ${clipped}`;
    })
    .filter((line) => typeof line === "string" && line.length > 0);

  if (lines.length === 0) {
    return "";
  }

  return `Recent Sensory Tail:\n${lines.join("\n")}`;
};

const isSubconsciousEchoText = (text) => {
  if (typeof text !== "string") {
    return false;
  }

  const normalized = text.trim();
  return (
    normalized.startsWith("Working Memory for query:") ||
    normalized.startsWith("[Subconscious Memory]") ||
    normalized.includes("\nWorking Memory for query:")
  );
};

const isInjectedSubconsciousMessage = (message, text) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.customType === "subconscious-working-memory") {
    return true;
  }

  const source = message.details?.source;
  if (source === "subconscious") {
    return true;
  }

  return isSubconsciousEchoText(text);
};

const toToolResult = (value) => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const withErrorResult = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
    details: { error: message }
  };
};

const defineTool = (pi, definition) => {
  pi.registerTool({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    async execute(_toolCallId, params) {
      try {
        const result = await definition.run(params ?? {});
        return {
          content: [{ type: "text", text: toToolResult(result) }],
          details: { result }
        };
      } catch (error) {
        log("error", `tool failed: ${definition.name}`, {
          error: error instanceof Error ? error.message : String(error)
        });
        return withErrorResult(error);
      }
    }
  });
};

const registerMemoryTools = (pi) => {
  const common = [
    {
      name: "memory_recall",
      label: "Memory Recall",
      description: "Recall working memory from subconscious storage for a query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          sessionId: { type: "string" },
          limit: { type: "number" },
          detailLevel: { type: "string", enum: ["summary", "full"] }
        },
        required: ["query"]
      },
      run: (params) =>
        request("POST", "/recall", {
          query: String(params.query ?? ""),
          sessionId: params.sessionId ? String(params.sessionId) : undefined,
          limit: params.limit ? Number(params.limit) : undefined,
          detailLevel:
            params.detailLevel === "full" || params.detailLevel === "summary"
              ? params.detailLevel
              : defaultDetail
        })
    },
    {
      name: "memory_search",
      label: "Memory Search",
      description: "Search across conversation, short-term, and long-term memory layers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          layer: { type: "string", enum: ["all", "conversation", "short_term", "long_term"] },
          sessionId: { type: "string" },
          limit: { type: "number" }
        },
        required: ["query"]
      },
      run: (params) => {
        const query = new URLSearchParams({
          q: String(params.query ?? ""),
          layer: String(params.layer ?? "all")
        });

        if (params.sessionId) {
          query.set("sessionId", String(params.sessionId));
        }

        if (params.limit) {
          query.set("limit", String(Number(params.limit)));
        }

        return request("GET", `/search?${query.toString()}`);
      }
    },
    {
      name: "memory_get",
      label: "Memory Get",
      description: "Get one memory node with its neighborhood.",
      parameters: {
        type: "object",
        properties: {
          memoryId: { type: "string" }
        },
        required: ["memoryId"]
      },
      run: (params) => request("GET", `/memory/${encodeURIComponent(String(params.memoryId ?? ""))}`)
    },
    {
      name: "memory_trace",
      label: "Memory Trace",
      description: "Trace memory provenance back to source conversation logs.",
      parameters: {
        type: "object",
        properties: {
          memoryId: { type: "string" }
        },
        required: ["memoryId"]
      },
      run: (params) => request("GET", `/trace/${encodeURIComponent(String(params.memoryId ?? ""))}`)
    },
    {
      name: "memory_status",
      label: "Memory Status",
      description: "Get memory engine health and background queue stats.",
      parameters: {
        type: "object",
        properties: {}
      },
      run: () => request("GET", "/status")
    }
  ];

  const management = [
    {
      name: "memory_consolidate",
      label: "Memory Consolidate",
      description: "Trigger immediate subconscious consolidation.",
      parameters: { type: "object", properties: {} },
      run: () => request("POST", "/consolidate", {})
    },
    {
      name: "memory_archive",
      label: "Memory Archive",
      description: "Manually archive a memory.",
      parameters: {
        type: "object",
        properties: { memoryId: { type: "string" } },
        required: ["memoryId"]
      },
      run: (params) => request("POST", `/archive/${encodeURIComponent(String(params.memoryId ?? ""))}`, {})
    },
    {
      name: "memory_forget",
      label: "Memory Forget",
      description: "Mark a memory as forgotten.",
      parameters: {
        type: "object",
        properties: { memoryId: { type: "string" } },
        required: ["memoryId"]
      },
      run: (params) => request("POST", `/forget/${encodeURIComponent(String(params.memoryId ?? ""))}`, {})
    },
    {
      name: "memory_reinforce",
      label: "Memory Reinforce",
      description: "Manually strengthen a memory.",
      parameters: {
        type: "object",
        properties: {
          memoryId: { type: "string" },
          amount: { type: "number" }
        },
        required: ["memoryId"]
      },
      run: (params) =>
        request("POST", `/reinforce/${encodeURIComponent(String(params.memoryId ?? ""))}`, {
          amount: params.amount ? Number(params.amount) : undefined
        })
    },
    {
      name: "memory_associate",
      label: "Memory Associate",
      description: "Create an explicit memory edge.",
      parameters: {
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
      },
      run: (params) =>
        request("POST", "/associate", {
          a: String(params.a ?? ""),
          b: String(params.b ?? ""),
          edge: String(params.edge ?? "related_to"),
          weight: params.weight ? Number(params.weight) : undefined
        })
    }
  ];

  for (const tool of [...common, ...(toolSet === "full" ? management : [])]) {
    defineTool(pi, tool);
  }

  log("info", "registered memory tools", {
    toolSet,
    count: common.length + (toolSet === "full" ? management.length : 0)
  });
};

export default function subconsciousExtension(pi) {
  registerMemoryTools(pi);

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = extractSessionId(ctx);

    try {
      const recentQuery = new URLSearchParams({
        sessionId,
        limit: "6",
        fallbackGlobal: "true"
      });

      const [recalled, recent] = await Promise.all([
        request("POST", "/recall", {
          query: "session start context",
          sessionId,
          detailLevel: defaultDetail
        }),
        request("GET", `/conversation/recent?${recentQuery.toString()}`)
      ]);

      const recalledContext = typeof recalled?.context === "string" ? recalled.context : "";
      const recentMessages = Array.isArray(recent?.messages) ? recent.messages : [];
      const sensoryContext = formatSensoryTail(recentMessages);
      const context = [recalledContext, sensoryContext]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean)
        .join("\n\n");
      startupContextBySession.set(sessionId, context);

      log("info", "session_start: startup context refreshed", {
        sessionId,
        recalledLength: recalledContext.length,
        sensoryCount: recentMessages.length,
        sensoryLength: sensoryContext.length,
        mergedLength: context.length
      });
    } catch (error) {
      log("warn", "session_start: startup context failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = extractSessionId(ctx);
    const prompt = typeof event?.prompt === "string" && event.prompt.trim().length > 0
      ? event.prompt
      : "pi prompt";

    try {
      const recalled = await request("POST", "/recall", {
        query: prompt,
        sessionId,
        detailLevel: defaultDetail
      });

      const runtimeContext = typeof recalled?.context === "string" ? recalled.context : "";
      const startupContext = startupContextBySession.get(sessionId) ?? "";
      const merged = [startupContext, runtimeContext]
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter(Boolean)
        .join("\n\n");

      log("debug", "before_agent_start: recall complete", {
        sessionId,
        startupLength: startupContext.length,
        runtimeLength: runtimeContext.length,
        mergedLength: merged.length
      });

      if (!merged) {
        return undefined;
      }

      if (injectMode === "system_prompt") {
        const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
        return {
          systemPrompt: `${base}\n\n[Subconscious Memory]\n${merged}`.trim()
        };
      }

      return {
        message: {
          customType: "subconscious-working-memory",
          content: merged,
          display: messageDisplay,
          details: {
            source: "subconscious",
            sessionId
          }
        }
      };
    } catch (error) {
      log("warn", "before_agent_start: recall failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const sessionId = extractSessionId(ctx);
    const rawMessages = Array.isArray(event?.messages) ? event.messages : [];
    let droppedEchoes = 0;

    const messages = rawMessages
      .map((message) => {
        const text = extractText(message?.content);
        const shouldDrop = isInjectedSubconsciousMessage(message, text);

        if (shouldDrop) {
          droppedEchoes += 1;
          return null;
        }

        return {
          sessionId,
          role: normalizeRole(message?.role),
          content: text,
          timestamp: typeof message?.timestamp === "number" ? message.timestamp : undefined,
          channel: "pi"
        };
      })
      .filter((message) => message && message.content.length > 0);

    if (droppedEchoes > 0) {
      log("debug", "agent_end: dropped injected subconscious messages", {
        sessionId,
        droppedEchoes
      });
    }

    if (messages.length === 0) {
      return;
    }

    try {
      await request("POST", "/ingest/conversation", { messages });
      log("info", "agent_end: ingested messages", {
        sessionId,
        messageCount: messages.length
      });
    } catch (error) {
      log("warn", "agent_end: ingestion failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const sessionId = extractSessionId(ctx);

    try {
      await request("POST", "/consolidate", {});
      log("info", "session_before_compact: consolidation triggered", { sessionId });
    } catch (error) {
      log("warn", "session_before_compact: consolidation failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = extractSessionId(ctx);
    startupContextBySession.delete(sessionId);

    try {
      await request("POST", "/consolidate", {});
      const status = await request("GET", "/status");
      log("info", "session_shutdown: consolidated and fetched status", {
        sessionId,
        queueDepth: status?.queueDepth,
        conversationEntryCount: status?.conversationEntryCount
      });
    } catch (error) {
      log("warn", "session_shutdown: finalization failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  log("info", "extension initialized", {
    apiBase,
    injectMode,
    messageDisplay,
    toolSet,
    defaultDetail,
    logLevel
  });
}
