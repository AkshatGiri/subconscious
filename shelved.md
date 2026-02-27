# Shelved Ideas

## Core Identity Memory Lane
Status: Shelved for later exploration.

Concept:
- Add a dedicated identity/core memory lane that reinforces who the agent is.
- These memories are pinned/protected and decay differently (or not at all).
- Always include a compact subset of identity memories in working-memory context assembly.

Potential implementation:
- Add `isPinned`/`identity` markers on memory nodes.
- Add `memory_pin` and `memory_unpin` tools.
- Add recall policy: prepend top identity memories before normal salience selection.

## Project-Level Summaries
Status: Shelved for later exploration.

Concept:
- Keep first-class project/conversation summary artifacts in addition to raw logs and memory nodes.
- Support periodic "state of project" snapshots for faster warm starts and continuity.

Potential implementation:
- Add `project_summaries` table keyed by `project_id`/`scope_id`.
- Add summarization cadence (time-based and event-based triggers).
- Add retrieval policy that includes latest summary + diff-from-last snapshot.

## Scoped Memories by Counterparty/Context
Status: Shelved for later exploration.

Concept:
- Not all memories belong in global/core memory.
- Support scoped memories based on who the agent is talking to (e.g., DM vs group chat participant sets).

Potential implementation:
- Add memory scope metadata (`scope_type`, `scope_id`, `participants_hash`, `visibility`).
- Add recall filtering/weighting by active scope and participant set.
- Add promotion rules from scoped -> core memory only when reinforced across contexts.

## Cloud Multi-Agent Memory + Shared Learning
Status: Shelved for later exploration.

Concept:
- Run memory service centrally for many agents.
- Allow "shared" memories to propagate knowledge upgrades across a swarm while preserving per-agent private memory.

Potential implementation:
- Multi-tenant architecture: `tenant -> agent -> scope`.
- Add memory visibility levels: `private`, `team`, `global`.
- Add replication/sync pipeline for shared memories with conflict resolution and provenance controls.
