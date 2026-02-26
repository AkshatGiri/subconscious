# Brain-Inspired Memory Engine (memowy2)

Standalone, harness-agnostic memory engine built with Bun + TypeScript.

It mirrors human-like memory layers:
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
- `MEMORY_DECAY_HALF_LIFE_HOURS` (default `48`)

## Development

Scripts:
- `bun run dev` (hot reload REST server)
- `bun run start`
- `bun run status`
- `bun run typecheck`
- `bun run test`

Project layout:
- `src/core` engine
- `src/subconscious` extraction + background worker
- `src/storage` sqlite graph/log store
- `src/adapters` harness adapters
- `src/api` REST adapter/server
- `tests` bun tests
- `docs` architecture notes
