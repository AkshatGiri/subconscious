import type {
  ConversationMessage,
  LLMExtractionResult,
  MemoryNode,
  MemoryNodeType,
  SubconsciousLLM
} from "../types";
import { topTokens, textSimilarity } from "../utils/text";

export interface ExtractedMemoryDraft {
  type: MemoryNodeType;
  title: string;
  content: string;
  topics: string[];
  categories: string[];
  confidence: number;
}

const dedupeDrafts = (drafts: ExtractedMemoryDraft[]): ExtractedMemoryDraft[] => {
  const accepted: ExtractedMemoryDraft[] = [];

  for (const candidate of drafts) {
    const duplicate = accepted.some(
      (existing) =>
        existing.type === candidate.type &&
        textSimilarity(existing.content, candidate.content) >= 0.9
    );

    if (!duplicate) {
      accepted.push(candidate);
    }
  }

  return accepted;
};

const fromLLM = (result: LLMExtractionResult | null): ExtractedMemoryDraft[] => {
  if (!result || result.memories.length === 0) {
    return [];
  }

  return result.memories
    .filter((entry) => entry.content.trim().length > 0)
    .map((entry) => ({
      type: entry.type,
      title: entry.title.trim() || `${entry.type.toUpperCase()} Memory`,
      content: entry.content.trim(),
      topics: entry.topics,
      categories: entry.categories,
      confidence: entry.confidence
    }));
};

const semanticPatterns: Array<{ pattern: RegExp; category: string }> = [
  {
    pattern: /\b(?:i|we|the user)\s+(?:prefer|likes?|love|hate|avoid)\s+([^.!?\n]+)/i,
    category: "preference"
  },
  {
    pattern: /\b(?:project|we|system|app)\s+(?:uses?|is using|runs on)\s+([^.!?\n]+)/i,
    category: "fact"
  },
  {
    pattern: /\b(?:my name is|i am)\s+([^.!?\n]+)/i,
    category: "person"
  },
  {
    pattern: /\b(?:decision|decided|chose|selected)\s+([^.!?\n]+)/i,
    category: "decision"
  }
];

const episodicPattern =
  /\b(?:debugged|fixed|resolved|deployed|investigated|shipped|migrated|incident|outage)\b/i;

const proceduralPattern =
  /(\b(?:process|workflow|runbook|steps?)\b.*:)|((?:^|\n)\s*\d+\.\s+[^\n]+)/i;

export const heuristicExtract = (messages: ConversationMessage[]): ExtractedMemoryDraft[] => {
  const drafts: ExtractedMemoryDraft[] = [];

  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }

    for (const entry of semanticPatterns) {
      const match = content.match(entry.pattern);
      if (!match) {
        continue;
      }

      const extracted = match[1]?.trim();
      if (!extracted) {
        continue;
      }
      const topics = topTokens(content, 6);
      drafts.push({
        type: "semantic",
        title: `Semantic: ${entry.category}`,
        content: extracted,
        topics,
        categories: [entry.category, "fact"],
        confidence: 0.63
      });
    }

    if (episodicPattern.test(content)) {
      drafts.push({
        type: "episodic",
        title: "Episode",
        content,
        topics: topTokens(content, 6),
        categories: ["event"],
        confidence: 0.58
      });
    }

    if (proceduralPattern.test(content) || content.includes("->") || content.includes("=>")) {
      drafts.push({
        type: "procedural",
        title: "Workflow",
        content,
        topics: topTokens(content, 6),
        categories: ["workflow", "how-to"],
        confidence: 0.56
      });
    }
  }

  return dedupeDrafts(drafts);
};

export const extractMemories = async (params: {
  messages: ConversationMessage[];
  currentSummary: string;
  llm?: SubconsciousLLM;
}): Promise<ExtractedMemoryDraft[]> => {
  const heuristic = heuristicExtract(params.messages);

  if (!params.llm) {
    return heuristic;
  }

  const llmResult = await params.llm.extract({
    messages: params.messages,
    currentSummary: params.currentSummary
  });

  const combined = [...heuristic, ...fromLLM(llmResult)];
  return dedupeDrafts(combined);
};

export const contradictionScore = (a: MemoryNode, b: MemoryNode): number => {
  if (a.type !== b.type) {
    return 0;
  }

  const sharedTopicCount = a.topics.filter((topic) => b.topics.includes(topic)).length;
  const base = textSimilarity(a.content, b.content);
  const negativeSignals = /(no|not|never|avoid|deprecated|replaced|stop|instead)/i;
  const oppositeTone = Number(negativeSignals.test(a.content) !== negativeSignals.test(b.content));

  return Math.min(1, base * 0.7 + sharedTopicCount * 0.08 + oppositeTone * 0.25);
};
