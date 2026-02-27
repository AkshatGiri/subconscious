import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

const diagramsDir = join(process.cwd(), "docs", "diagrams");
const outputFile = join(diagramsDir, "index.html");

const files = readdirSync(diagramsDir)
  .filter((file) => extname(file) === ".mmd")
  .sort();

if (files.length === 0) {
  throw new Error("No .mmd diagram files found in docs/diagrams");
}

const sections = files
  .map((file) => {
    const source = readFileSync(join(diagramsDir, file), "utf8").trim();
    const title = basename(file, ".mmd").replace(/[-_]/g, " ");

    return `
      <section class="diagram-card">
        <h2>${title}</h2>
        <details>
          <summary>Show Mermaid Source</summary>
          <pre><code>${source
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</code></pre>
        </details>
        <pre class="mermaid">${source}</pre>
      </section>
    `;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Memory Engine Diagrams</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7fb;
        --surface: #ffffff;
        --text: #101828;
        --muted: #475467;
        --border: #d0d5dd;
      }

      body {
        margin: 0;
        padding: 24px;
        font-family: "SF Mono", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono",
          "Courier New", monospace;
        background: radial-gradient(circle at top left, #d9e7ff, var(--bg) 34%);
        color: var(--text);
      }

      main {
        max-width: 1200px;
        margin: 0 auto;
        display: grid;
        gap: 20px;
      }

      h1 {
        margin: 0;
        font-size: 28px;
      }

      p {
        margin: 4px 0 0;
        color: var(--muted);
      }

      .diagram-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 18px;
        box-shadow: 0 8px 20px rgba(16, 24, 40, 0.07);
      }

      .diagram-card h2 {
        margin-top: 0;
        text-transform: capitalize;
      }

      .diagram-card details {
        margin-bottom: 12px;
      }

      .diagram-card summary {
        cursor: pointer;
        font-size: 12px;
      }

      pre code {
        display: block;
        overflow-x: auto;
        background: #101828;
        color: #f2f4f7;
        border-radius: 8px;
        padding: 12px;
        font-size: 12px;
      }

      .mermaid {
        overflow-x: auto;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Memory Engine Diagrams</h1>
        <p>Generated from Mermaid source files in docs/diagrams/*.mmd</p>
      </header>
      ${sections}
    </main>

    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral" });
    </script>
  </body>
</html>
`;

mkdirSync(diagramsDir, { recursive: true });
await Bun.write(outputFile, html);
console.log(`Wrote ${outputFile} with ${files.length} rendered Mermaid blocks.`);
