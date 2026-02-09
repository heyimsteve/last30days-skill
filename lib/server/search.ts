import { OpenRouterUsage, extractTextFromOpenRouterResponse, extractUsage, openRouterRequest } from "@/lib/server/openrouter";
import { parseRedditItems, parseWebItems, parseXItems, parseYouTubeItems } from "@/lib/server/parse";
import { SourceType } from "@/lib/types";

interface OpenRouterResponsesResponse {
  output?: unknown;
  choices?: unknown;
  error?: { message?: string };
}

type Depth = "quick" | "default" | "deep";

const DEPTH_LIMITS: Record<Depth, { min: number; max: number }> = {
  quick: { min: 8, max: 15 },
  default: { min: 20, max: 35 },
  deep: { min: 45, max: 70 },
};

export interface SearchParams {
  topic: string;
  fromDate: string;
  toDate: string;
  depth: Depth;
  signal?: AbortSignal;
}

interface SourceSearchResult<T> {
  items: T[];
  usage: OpenRouterUsage;
  model: string;
  durationMs: number;
}

function getSearchModelFor(source: SourceType) {
  if (source === "reddit") {
    return process.env.OPENROUTER_REDDIT_MODEL ?? "openai/gpt-5.2:online";
  }
  if (source === "x") {
    return process.env.OPENROUTER_X_MODEL ?? "x-ai/grok-4.1-fast:online";
  }
  if (source === "youtube") {
    return process.env.OPENROUTER_YOUTUBE_MODEL ?? "openai/gpt-5.2:online";
  }
  return process.env.OPENROUTER_WEB_MODEL ?? "openai/gpt-5.2:online";
}

function inputAsMessage(prompt: string) {
  return [{ role: "user", content: prompt }];
}

function getSearchTimeoutMs(depth: Depth) {
  if (depth === "quick") {
    return 180000;
  }
  if (depth === "deep") {
    return 330000;
  }
  return 270000;
}

export async function searchReddit({ topic, fromDate, toDate, depth, signal }: SearchParams) {
  const model = getSearchModelFor("reddit");
  const range = DEPTH_LIMITS[depth];
  const startedAt = Date.now();
  const prompt = `Find Reddit discussion threads about: ${topic}

Focus on content from ${fromDate} to ${toDate}.
Return ${range.min}-${range.max} relevant threads.

Return ONLY JSON:
{
  "items": [
    {
      "title": "Thread title",
      "url": "https://www.reddit.com/r/sub/comments/id/title/",
      "subreddit": "subreddit_name",
      "date": "YYYY-MM-DD or null",
      "engagement": {
        "score": 1234,
        "num_comments": 115,
        "upvote_ratio": 0.91
      },
      "why_relevant": "why this matters",
      "relevance": 0.0
    }
  ]
}

Rules:
- URL must include /r/ and /comments/
- relevance is 0.0 to 1.0
- include date if available; null if unknown`;

  const response = await openRouterRequest<OpenRouterResponsesResponse>({
    path: "/responses",
    payload: {
      model,
      tools: [{ type: "web_search" }],
      input: inputAsMessage(prompt),
    },
    timeoutMs: getSearchTimeoutMs(depth),
    signal,
  });

  return {
    items: parseRedditItems(extractTextFromOpenRouterResponse(response as Record<string, unknown>)),
    usage: extractUsage(response as Record<string, unknown>),
    model,
    durationMs: Date.now() - startedAt,
  } satisfies SourceSearchResult<ReturnType<typeof parseRedditItems>[number]>;
}

export async function searchX({ topic, fromDate, toDate, depth, signal }: SearchParams) {
  const model = getSearchModelFor("x");
  const range = DEPTH_LIMITS[depth];
  const startedAt = Date.now();
  const prompt = `Search X (Twitter) for posts about: ${topic}

Focus on posts from ${fromDate} to ${toDate}. Return ${range.min}-${range.max} posts with meaningful content.

Return ONLY JSON:
{
  "items": [
    {
      "text": "tweet text",
      "url": "https://x.com/user/status/123",
      "author_handle": "username",
      "date": "YYYY-MM-DD or null",
      "engagement": {
        "likes": 100,
        "reposts": 20,
        "replies": 15,
        "quotes": 2
      },
      "why_relevant": "why this matters",
      "relevance": 0.0
    }
  ]
}

Rules:
- relevance is 0.0 to 1.0
- include diverse authors
- date can be null when unknown`;

  const response = await openRouterRequest<OpenRouterResponsesResponse>({
    path: "/responses",
    payload: {
      model,
      tools: [{ type: "web_search" }],
      input: inputAsMessage(prompt),
    },
    timeoutMs: getSearchTimeoutMs(depth),
    signal,
  });

  return {
    items: parseXItems(extractTextFromOpenRouterResponse(response as Record<string, unknown>)),
    usage: extractUsage(response as Record<string, unknown>),
    model,
    durationMs: Date.now() - startedAt,
  } satisfies SourceSearchResult<ReturnType<typeof parseXItems>[number]>;
}

export async function searchWeb({ topic, fromDate, toDate, depth, signal }: SearchParams) {
  const model = getSearchModelFor("web");
  const range = DEPTH_LIMITS[depth];
  const startedAt = Date.now();
  const prompt = `Search the web for high-quality sources about: ${topic}

Window: ${fromDate} to ${toDate}. Return ${range.min}-${range.max} results.

Exclude reddit.com, x.com, and twitter.com results.
Prefer docs, blogs, changelogs, announcements, and reputable news.

Return ONLY JSON:
{
  "items": [
    {
      "title": "page title",
      "url": "https://example.com/post",
      "snippet": "short summary",
      "date": "YYYY-MM-DD or null",
      "why_relevant": "why this matters",
      "relevance": 0.0
    }
  ]
}

Rules:
- relevance is 0.0 to 1.0
- include date if known; null if unknown`;

  const response = await openRouterRequest<OpenRouterResponsesResponse>({
    path: "/responses",
    payload: {
      model,
      tools: [{ type: "web_search" }],
      input: inputAsMessage(prompt),
    },
    timeoutMs: getSearchTimeoutMs(depth),
    signal,
  });

  return {
    items: parseWebItems(extractTextFromOpenRouterResponse(response as Record<string, unknown>)),
    usage: extractUsage(response as Record<string, unknown>),
    model,
    durationMs: Date.now() - startedAt,
  } satisfies SourceSearchResult<ReturnType<typeof parseWebItems>[number]>;
}

export async function searchYouTube({ topic, fromDate, toDate, depth, signal }: SearchParams) {
  const model = getSearchModelFor("youtube");
  const range = DEPTH_LIMITS[depth];
  const startedAt = Date.now();
  const prompt = `Search YouTube for videos and channels about: ${topic}

Window: ${fromDate} to ${toDate}. Return ${range.min}-${range.max} relevant YouTube results.

Return ONLY JSON:
{
  "items": [
    {
      "title": "video title",
      "url": "https://www.youtube.com/watch?v=...",
      "channel": "channel name",
      "snippet": "short summary",
      "date": "YYYY-MM-DD or null",
      "engagement": {
        "views": 10000,
        "likes": 400,
        "num_comments": 80
      },
      "why_relevant": "why this matters",
      "relevance": 0.0
    }
  ]
}

Rules:
- url must be youtube.com/watch or youtu.be
- relevance is 0.0 to 1.0
- include date if known; null if unknown`;

  const response = await openRouterRequest<OpenRouterResponsesResponse>({
    path: "/responses",
    payload: {
      model,
      tools: [{ type: "web_search" }],
      input: inputAsMessage(prompt),
    },
    timeoutMs: getSearchTimeoutMs(depth),
    signal,
  });

  return {
    items: parseYouTubeItems(extractTextFromOpenRouterResponse(response as Record<string, unknown>)),
    usage: extractUsage(response as Record<string, unknown>),
    model,
    durationMs: Date.now() - startedAt,
  } satisfies SourceSearchResult<ReturnType<typeof parseYouTubeItems>[number]>;
}
