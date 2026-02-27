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

## Adapter Layer

Implemented adapters:

- `OpenClawMemoryAdapter`
- `ClaudeCodeMemoryAdapter` (MCP-style tool mapping)
- `OpenCodeMemoryAdapter`
- `CodexMemoryAdapter`
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
