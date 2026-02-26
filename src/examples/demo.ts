import { MemoryEngine } from "../core/memory-engine";

const engine = new MemoryEngine({
  dbPath: "./data/demo-memory.db"
});

await engine.ingest({
  kind: "conversation",
  messages: [
    {
      sessionId: "demo-session",
      role: "user",
      content: "I prefer Bun over Node for CLI tools."
    },
    {
      sessionId: "demo-session",
      role: "assistant",
      content: "Got it. We debugged the auth bug yesterday and the root cause was a stale token."
    },
    {
      sessionId: "demo-session",
      role: "user",
      content: "Deploy process is test -> build -> push -> verify."
    }
  ]
});

await Bun.sleep(150);

const recalled = await engine.recall("what does the user prefer and what is the deploy process?", {
  sessionId: "demo-session",
  detailLevel: "full"
});

console.log(recalled.context);

const status = engine.status();
console.log("\nStatus:");
console.log(JSON.stringify(status, null, 2));

await engine.shutdown();
