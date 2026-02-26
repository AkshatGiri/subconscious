const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "and",
  "or",
  "that",
  "this",
  "with",
  "be",
  "it",
  "as",
  "by",
  "from",
  "we",
  "you",
  "i",
  "they",
  "he",
  "she",
  "was",
  "were",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "about",
  "what",
  "when",
  "where",
  "why",
  "how"
]);

export const normalizeText = (value: string): string => value.toLowerCase().trim();

export const tokenize = (value: string): string[] =>
  normalizeText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

export const textSimilarity = (a: string, b: string): number => {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));

  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / Math.sqrt(aTokens.size * bTokens.size);
};

export const topTokens = (value: string, limit = 8): string[] => {
  const counts = new Map<string, number>();
  for (const token of tokenize(value)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
};

export const summarizeMessages = (
  messages: Array<{ role: string; content: string }>,
  maxChars = 1200
): string => {
  if (messages.length === 0) {
    return "";
  }

  const merged = messages
    .map((msg) => `${msg.role}: ${msg.content}`)
    .join("\n")
    .trim();

  if (merged.length <= maxChars) {
    return merged;
  }

  return `${merged.slice(0, maxChars - 3)}...`;
};
