# Subconscious - Human Inspired Memory for Agents

Standalone, harness-agnostic memory engine built with Bun + TypeScript.

## Why This Exists

Most agent memory systems today rely on one of three patterns:

- stuffing long transcript context into prompts
- vector-only retrieval with weak structure
- manual summaries that drift over time

Those approaches break down with scale: context bloat, stale or contradictory memories, and weak causal/temporal continuity.

Humans handle memory differently. We know enough about the architecture to borrow useful primitives:

- sensory logging of experience
- short-term/working memory for active tasks
- long-term semantic, episodic, and procedural memory
- consolidation and replay (especially during rest/sleep)
- forgetting curves and recall-based reinforcement

We do not know every detail of human memory, but we can implement this structure now, measure behavior, and tune.

## Core Differentiator

This system has a dedicated **subconscious** loop: a secondary model/process that continuously extracts, organizes, links, consolidates, and prunes memory in the background. During recall, it activates relevant graph paths and reinforces recalled memories, similar to how human memories are reactivated and reconsolidated.

## Layered Model

It uses human-inspired layers:

- Layer 0: append-only conversation/document log
- Layer 1: short-term rolling session summary + working buffer
- Layer 2: persistent long-term graph memory (semantic / episodic / procedural nodes + typed edges)
- Layer 3: computed working memory (top ~7 recalled items)

A background "subconscious" process continuously runs extraction, association, consolidation, summarization, and decay.

## Quick Start

```bash
bun install
bun run typecheck
bun test
bun run start
```

Server starts at `http://localhost:8787` by default.

## Core API (Engine)

`MemoryEngine` supports:

- `ingest(conversation | document | fact)`
- `recall(query, context?)`
- `search(query, opts?)`
- `get(memoryId)`
- `trace(memoryId)`
- `consolidate()`
- `archive(memoryId)`
- `forget(memoryId)`
- `reinforce(memoryId)`
- `associate(a, b, edge)`
- `status()`

## REST API

- `GET /health`
- `GET /status`
- `GET /tools`
- `POST /ingest/conversation`
- `POST /ingest/document`
- `POST /ingest/fact`
- `POST /recall`
- `GET /search?q=...&layer=all`
- `GET /conversation/recent?limit=6&sessionId=...`
- `GET /memory/:id`
- `GET /trace/:id`
- `POST /consolidate`
- `POST /archive/:id`
- `POST /forget/:id`
- `POST /reinforce/:id`
- `POST /associate`

Example:

```bash
curl -X POST http://localhost:8787/ingest/conversation \
  -H 'content-type: application/json' \
  -d '{
    "messages": [
      {"sessionId":"s1","role":"user","content":"I prefer Bun for backend tooling"},
      {"sessionId":"s1","role":"assistant","content":"Noted"}
    ]
  }'

curl -X POST http://localhost:8787/recall \
  -H 'content-type: application/json' \
  -d '{"query":"what runtime preference exists?","sessionId":"s1"}'
```

`/recall` omits memory embeddings by default to keep payloads compact.  
Pass `"includeEmbedding": true` only when you explicitly need raw vectors for debugging.

## Adapter Layer

Implemented adapters:

- `OpenClawMemoryAdapter`
- `ClaudeCodeMemoryAdapter` (MCP-style tool mapping)
- `OpenCodeMemoryAdapter`
- `CodexMemoryAdapter`
- `PiMemoryAdapter`
- `RestMemoryAdapter`

All adapters share a common interface and tool definitions via `BaseMemoryAdapter`.

OpenClaw adapter now supports both tools and lifecycle hook wiring:

```ts
import { MemoryEngine, OpenClawMemoryAdapter } from "./src";

const engine = new MemoryEngine();
const adapter = new OpenClawMemoryAdapter(engine);

adapter.registerWith(openclawApi, {
  includeTools: true,
  includeHooks: true,
});
```

`registerWith()` supports two OpenClaw hook styles:

- callback registrars like `onSessionStart(handler)`, `onBeforeAgentRun(handler)`, etc.
- generic `registerHook(name, handler)` with names:
  `conversation_message`, `session_start`, `before_agent_run`, `after_agent_run`, `context_overflow`, `session_end`

Pi adapter follows the same pattern and adds simple direct helpers:

```ts
import { MemoryEngine, PiMemoryAdapter } from "./src";

const engine = new MemoryEngine();
const adapter = new PiMemoryAdapter(engine);

const context = await adapter.beforeResponse("pi-session-1", "what do you remember about me?");
await adapter.afterResponse("pi-session-1", [
  { role: "user", content: "I prefer Bun for local tools." },
  { role: "assistant", content: "Noted." }
]);
```

For official pi extension runtime (`pi.on(...)` + `pi.registerTool(...)`), use:

```ts
import { MemoryEngine, PiMemoryAdapter } from "./src";

export default function (pi: {
  on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
  registerTool: (tool: Record<string, unknown>) => void;
}) {
  const engine = new MemoryEngine();
  const adapter = new PiMemoryAdapter(engine);

  adapter.registerWithPiExtension(pi, {
    includeTools: true,
    includeLifecycle: true,
    injectMode: "message"
  });
}
```

`registerWithPiExtension()` wires:

- `session_start` (seed startup context from recall + recent sensory tail)
- `before_agent_start` (inject working memory before response)
- `agent_end` (ingest turn messages)
- `session_before_compact` (trigger consolidation)
- `session_shutdown` (final consolidation/cleanup)

### Pi CLI Extension (Practical Runtime Setup)

Pi runs extensions in its own runtime, while this engine uses Bun (`bun:sqlite`).  
Use the included bridge extension to call the memory REST API:

- Extension file: `extensions/pi-subconscious.js`
- Flow: `pi extension -> HTTP -> Bun memory engine (with subconscious loop)`

Run it in two terminals:

```bash
# Terminal 1: memory engine + verbose subconscious logs
MEMORY_LLM_ENABLED=true \
MEMORY_LLM_API_KEY=YOUR_KEY \
MEMORY_LOG_LEVEL=debug \
bun run start
```

```bash
# Terminal 2: pi with extension
SUBCONSCIOUS_API_URL=http://127.0.0.1:8787 \
SUBCONSCIOUS_EXT_LOG_LEVEL=debug \
SUBCONSCIOUS_EXT_TRACE_IO=true \
pi -e ./extensions/pi-subconscious.js
```

Optional extension envs:

- `SUBCONSCIOUS_INJECT_MODE=message|system_prompt` (default `message`)
- `SUBCONSCIOUS_MESSAGE_DISPLAY=true|false` (default `false`)
- `SUBCONSCIOUS_TOOL_SET=minimal|full` (default `minimal`)
- `SUBCONSCIOUS_RECALL_DETAIL=summary|full` (default `summary`)
- `SUBCONSCIOUS_EXT_TRACE_IO=true|false` (default `false`; logs all extension<->memory API I/O)
- `SUBCONSCIOUS_EXT_TRACE_MAX_CHARS=<n>` (default `6000` per string field)
- `SUBCONSCIOUS_EXT_TRACE_MAX_ARRAY_ITEMS=<n>` (default `20`)
- `SUBCONSCIOUS_EXT_TRACE_MAX_OBJECT_KEYS=<n>` (default `30`)

To install permanently for `/reload` auto-discovery:

```bash
mkdir -p ~/.pi/agent/extensions
cp ./extensions/pi-subconscious.js ~/.pi/agent/extensions/subconscious.js
```

## Optional LLM Subconscious

By default, extraction/summarization is heuristic and fully local.

To enable OpenAI-compatible background LLM calls, set:

```bash
MEMORY_LLM_ENABLED=true
MEMORY_LLM_PROVIDER=openai_compatible
MEMORY_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
MEMORY_LLM_API_KEY=...
MEMORY_LLM_MODEL=gpt-4.1-mini
MEMORY_LLM_TEMPERATURE=0.1
```

## Config

Useful env vars:

- `MEMORY_DB_PATH` (default `./data/memory.db`)
- `MEMORY_LOG_LEVEL` (default `warn`; set `debug` for detailed subconscious logs)
- `MEMORY_WORKING_SIZE` (default `7`)
- `MEMORY_SHORT_TERM_BUFFER_SIZE` (default `20`)
- `MEMORY_CANDIDATE_POOL_SIZE` (default `64`)
- `MEMORY_GRAPH_EXPANSION_DEPTH` (default `2`)
- `MEMORY_DECAY_HALF_LIFE_HOURS` (default `336`)
- `MEMORY_DECAY_CURVE_SHAPE` (default `1.35`)
- `MEMORY_DECAY_AUTO_ARCHIVE` (default `false`)
- `MEMORY_RECALL_REFRESH_BASE_BOOST` (default `0.14`)
- `MEMORY_RECALL_REFRESH_MAX_BOOST` (default `0.42`)
- `MEMORY_RECALL_REFRESH_WINDOW_HOURS` (default `720`)

Decay behavior defaults to score-only weakening (no auto-archive). Recalled memories get a strong refresh boost, scaled by staleness.

## Development

Scripts:

- `bun run dev` (hot reload REST server)
- `bun run start`
- `bun run status`
- `bun run typecheck`
- `bun run test`
- `bun run diagrams:build` (generate `docs/diagrams/index.html` from Mermaid source)
- `bun run diagrams:serve` (serve diagram viewer at `http://localhost:8890`)
- `bun run diagrams` (build + serve in one command)

Project layout:

- `src/core` engine
- `src/subconscious` extraction + background worker
- `src/storage` sqlite graph/log store
- `src/adapters` harness adapters
- `src/api` REST adapter/server
- `tests` bun tests
- `docs` architecture notes

## Diagrams

Mermaid sources live in:

- `docs/diagrams/process.mmd`
- `docs/diagrams/data-model.mmd`

Render them with code:

```bash
bun run diagrams:build
bun run diagrams:serve
```

Then open:

- `http://localhost:8890`
