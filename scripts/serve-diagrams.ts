import { existsSync } from "node:fs";
import { join } from "node:path";

const diagramsDir = join(process.cwd(), "docs", "diagrams");
const indexPath = join(diagramsDir, "index.html");

if (!existsSync(indexPath)) {
  console.error("docs/diagrams/index.html not found. Run: bun run diagrams:build");
  process.exit(1);
}

const server = Bun.serve({
  port: Number(Bun.env.DIAGRAMS_PORT ?? 8890),
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(indexPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname.endsWith(".mmd")) {
      const filePath = join(diagramsDir, url.pathname.replace(/^\/+/, ""));
      return new Response(Bun.file(filePath), {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
});

console.log(`Diagram viewer running at http://localhost:${server.port}`);
