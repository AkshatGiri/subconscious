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
