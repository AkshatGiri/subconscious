import { MemoryEngine } from "./src/core/memory-engine";
import { RestMemoryAdapter } from "./src/api/rest-adapter";

const command = Bun.argv[2] ?? "serve";

const engine = new MemoryEngine();

if (command === "serve") {
  const portArg = Bun.argv.find((arg) => arg.startsWith("--port="));
  const hostArg = Bun.argv.find((arg) => arg.startsWith("--host="));

  const port = portArg ? Number(portArg.split("=")[1]) : undefined;
  const host = hostArg ? hostArg.split("=")[1] : undefined;

  const adapter = new RestMemoryAdapter(engine);
  const server = adapter.start({ port, host });

  console.log(`Memory engine REST API listening on http://${server.hostname}:${server.port}`);
} else if (command === "status") {
  console.log(JSON.stringify(engine.status(), null, 2));
  await engine.shutdown();
} else {
  console.error(`Unknown command: ${command}. Use: serve | status`);
  await engine.shutdown();
  process.exit(1);
}

const shutdown = async () => {
  await engine.shutdown();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
