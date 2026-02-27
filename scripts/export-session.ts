import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const home = Bun.env.HOME;
if (!home) {
  throw new Error("HOME is not set");
}

const historyPath = join(home, ".codex", "history.jsonl");
const historyText = await Bun.file(historyPath).text();
const historyLines = historyText
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (historyLines.length === 0) {
  throw new Error("No history entries found in ~/.codex/history.jsonl");
}

const last = JSON.parse(historyLines[historyLines.length - 1] ?? "{}") as {
  session_id?: string;
};

const sessionId = last.session_id;
if (!sessionId) {
  throw new Error("Could not determine current session_id from history.jsonl");
}

const sessionsRoot = join(home, ".codex", "sessions");
const candidates = readdirSync(sessionsRoot, { recursive: true })
  .filter((entry) => typeof entry === "string")
  .map((entry) => join(sessionsRoot, entry))
  .filter((path) => path.endsWith(".jsonl") && path.includes(sessionId));

if (candidates.length === 0) {
  throw new Error(`No session JSONL found for session_id=${sessionId}`);
}

candidates.sort();
const sessionFile = candidates.at(-1);
if (!sessionFile) {
  throw new Error(`No session JSONL found for session_id=${sessionId}`);
}
const sessionText = await Bun.file(sessionFile).text();

let sessionTimestamp = "";
const outputBlocks: string[] = [];

for (const line of sessionText.split("\n")) {
  if (!line.trim()) {
    continue;
  }

  const event = JSON.parse(line) as {
    timestamp?: string;
    type?: string;
    payload?: {
      type?: string;
      role?: string;
      content?: Array<{
        text?: string;
        input_text?: string;
        output_text?: string;
      }>;
    };
  };

  if (!sessionTimestamp && event.type === "session_meta") {
    const ts = (event as { payload?: { timestamp?: string } }).payload?.timestamp;
    if (ts) {
      sessionTimestamp = ts;
    }
  }

  if (event.type !== "response_item" || event.payload?.type !== "message") {
    continue;
  }

  const role = (event.payload.role ?? "unknown").toUpperCase();
  const text = (event.payload.content ?? [])
    .map((part) => part.text ?? part.input_text ?? part.output_text ?? "")
    .filter(Boolean)
    .join("\n");

  outputBlocks.push(`\n## [${event.timestamp ?? ""}] ${role}\n${text}`);
}

if (!sessionTimestamp) {
  sessionTimestamp = new Date().toISOString();
}

const safeTimestamp = sessionTimestamp.replace(/:/g, "-").replace(/\..*Z$/, "Z");
const outDir = join(process.cwd(), ".sessions");
mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, `${safeTimestamp}-codex-session-${sessionId}.md`);
await Bun.write(outFile, outputBlocks.join("\n"));

console.log(`Exported session to ${outFile}`);
console.log(`Source: ${sessionFile}`);
