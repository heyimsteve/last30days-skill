import { OpenRouterUsage, extractJsonObject, extractUsage, openRouterRequest } from "@/lib/server/openrouter";
import { SynthesisResult, WebItem, XItem, RedditItem, YouTubeItem } from "@/lib/types";

const SYNTH_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";

function compactReddit(items: RedditItem[]) {
  if (!items.length) {
    return "No Reddit items.";
  }

  return items
    .slice(0, 15)
    .map((item) => {
      const score = item.engagement?.score ?? "?";
      const comments = item.engagement?.num_comments ?? "?";
      return `- [score:${score} comments:${comments}] r/${item.subreddit}: ${item.title}`;
    })
    .join("\n");
}

function compactX(items: XItem[]) {
  if (!items.length) {
    return "No X items.";
  }

  return items
    .slice(0, 15)
    .map((item) => {
      const likes = item.engagement?.likes ?? 0;
      const reposts = item.engagement?.reposts ?? 0;
      return `- [${likes} likes ${reposts} reposts] @${item.author_handle}: ${item.text}`;
    })
    .join("\n");
}

function compactWeb(items: WebItem[]) {
  if (!items.length) {
    return "No web items.";
  }

  return items
    .slice(0, 15)
    .map((item) => `- [${item.source_domain}] ${item.title}: ${item.snippet}`)
    .join("\n");
}

function compactYouTube(items: YouTubeItem[]) {
  if (!items.length) {
    return "No YouTube items.";
  }

  return items
    .slice(0, 15)
    .map((item) => {
      const views = item.engagement?.views ?? 0;
      const likes = item.engagement?.likes ?? 0;
      return `- [${views} views ${likes} likes] ${item.channel}: ${item.title}`;
    })
    .join("\n");
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
}

export interface SynthesisRunResult {
  synthesis: SynthesisResult;
  usage: OpenRouterUsage;
  model: string;
  durationMs: number;
}

export async function synthesize(
  topic: string,
  reddit: RedditItem[],
  x: XItem[],
  web: WebItem[],
  youtube: YouTubeItem[] = [],
): Promise<SynthesisRunResult> {
  const model = process.env.OPENROUTER_SYNTH_MODEL ?? SYNTH_MODEL_DEFAULT;
  const startedAt = Date.now();

  const system = `You are a research synthesis expert.
Analyze cross-source findings and extract actionable patterns.
Return strict JSON with keys: summary, keyPatterns, recommendedFormat, caveats.`;

  const user = `Topic: ${topic}

Reddit:\n${compactReddit(reddit)}

X:\n${compactX(x)}

Web:\n${compactWeb(web)}

YouTube:\n${compactYouTube(youtube)}

Rules:
- summary: 2-4 sentences
- keyPatterns: 3-6 concrete items
- recommendedFormat: short text like JSON / structured / natural language
- caveats: one short paragraph
- No markdown in JSON`;

  const response = await openRouterRequest<ChatCompletionResponse>({
    path: "/chat/completions",
    payload: {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    },
    timeoutMs: 90000,
  });

  const raw = response.choices?.[0]?.message?.content?.trim() ?? "";
  const parsed = extractJsonObject<{
    summary?: string;
    keyPatterns?: unknown;
    recommendedFormat?: string;
    caveats?: string;
  }>(raw);

  const patterns = Array.isArray(parsed?.keyPatterns)
    ? parsed.keyPatterns.map((item) => String(item)).filter(Boolean).slice(0, 6)
    : [];

  const synthesis: SynthesisResult = {
    summary: parsed?.summary?.trim() || toReadableFallback(raw),
    keyPatterns: patterns,
    recommendedFormat: parsed?.recommendedFormat?.trim() || "Structured text",
    caveats: parsed?.caveats?.trim() || "No caveats were generated.",
    raw,
  };

  return {
    synthesis,
    usage: extractUsage(response as unknown as Record<string, unknown>),
    model,
    durationMs: Date.now() - startedAt,
  };
}

function toReadableFallback(raw: string) {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  if (!cleaned) {
    return "No synthesis summary was produced.";
  }
  return cleaned;
}
