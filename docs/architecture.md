# Architecture

## Layers

1. Sensory (Layer 0)
- Raw conversation entries and documents are immutable records in SQLite.
- Full-text searchable via FTS tables.

2. Short-Term (Layer 1)
- Per-session state stores rolling summary and last N message IDs.
- Updated on each ingest and refined by subconscious summarization.

3. Long-Term Graph (Layer 2)
- `memories` table stores semantic/episodic/procedural nodes.
- `memory_edges` table stores typed links (`related_to`, `reinforces`, `supersedes`, etc).
- `memory_sources` stores provenance to conversation/document sources.

4. Working Memory (Layer 3)
- Computed by `recall()` on demand.
- Candidate scoring combines embedding similarity, lexical match, recency, strength, and associative edge signals.
- Diversity filter prevents redundant top-k set.

## Subconscious Agent

`SubconsciousAgent` runs in the background:
- queue polling for new conversation ingestion tasks
- periodic consolidation cycle
- periodic decay cycle

Pipeline for conversation tasks:
- extract draft memories (heuristics + optional LLM)
- persist memories
- link `sourced_from` provenance
- associate with existing graph (related/reinforce)
- resolve contradictions (supersede, flag, or keep both)
- refresh short-term summary

## Retrieval Strategy (`recall`)

1. Query embedding + lexical score
2. Select seed memories
3. Graph neighborhood expansion
4. Composite salience scoring
5. Diversity-constrained top-k selection
6. Strengthen recalled memories (strength++, recall_count++, last_accessed)
7. Format context for harness injection

## Decay and Consolidation

- Decay applies exponential strength attenuation based on configurable half-life.
- Below threshold memories are archived (soft-forgotten).
- Consolidation merges highly similar duplicates and records `supersedes` links.

## Storage Notes

SQLite schema uses:
- row tables for logs/session/memory/edges/sources
- FTS5 virtual tables for conversation and memory text search
- WAL mode for concurrent read-heavy workflows
