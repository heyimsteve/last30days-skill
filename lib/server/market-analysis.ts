import { getDateRange } from "@/lib/server/date";
import { NicheCandidate, NicheResearchDepth, MarketAnalysisResult, NicheSource } from "@/lib/niche-types";
import { extractJsonObject, extractUsage, openRouterRequest } from "@/lib/server/openrouter";
import { searchReddit, searchWeb, searchX } from "@/lib/server/search";
import { applyDateAndConfidenceReddit, applyDateAndConfidenceWeb, applyDateAndConfidenceX, dedupeReddit, dedupeWeb, dedupeX, sortByScoreAndDate } from "@/lib/server/processing";
import { scoreReddit, scoreWeb, scoreX } from "@/lib/server/scoring";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
}

interface RawMarketSource {
  title?: unknown;
  url?: unknown;
  note?: unknown;
  type?: unknown;
  date?: unknown;
}

interface RawMarketAnalysis {
  subscores?: {
    demand?: unknown;
    urgency?: unknown;
    accessibility?: unknown;
    monetization?: unknown;
    competitionHeadroom?: unknown;
  };
  rationale?: unknown;
  risks?: unknown;
  sources?: unknown;
}

const ANALYSIS_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";

export async function runMarketAnalysis({
  candidate,
  mode,
}: {
  candidate: NicheCandidate;
  mode: NicheResearchDepth;
}): Promise<MarketAnalysisResult> {
  const range = getDateRange(30);
  const queries = buildMarketQueries(candidate);
  const usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const rawReddit = [] as Awaited<ReturnType<typeof searchReddit>>["items"];
  const rawX = [] as Awaited<ReturnType<typeof searchX>>["items"];
  const rawWeb = [] as Awaited<ReturnType<typeof searchWeb>>["items"];

  for (const query of queries) {
    const [redditResult, xResult, webResult] = await Promise.allSettled([
      searchReddit({ topic: query, fromDate: range.from, toDate: range.to, depth: mode }),
      searchX({ topic: query, fromDate: range.from, toDate: range.to, depth: mode }),
      searchWeb({ topic: query, fromDate: range.from, toDate: range.to, depth: mode }),
    ]);

    if (redditResult.status === "fulfilled") {
      rawReddit.push(...redditResult.value.items);
      addUsage(usageTotals, { ...redditResult.value.usage, calls: 1 });
    }
    if (xResult.status === "fulfilled") {
      rawX.push(...xResult.value.items);
      addUsage(usageTotals, { ...xResult.value.usage, calls: 1 });
    }
    if (webResult.status === "fulfilled") {
      rawWeb.push(...webResult.value.items);
      addUsage(usageTotals, { ...webResult.value.usage, calls: 1 });
    }
  }

  const limit = mode === "quick" ? 8 : mode === "deep" ? 24 : 16;
  const reddit = sortByScoreAndDate(dedupeReddit(scoreReddit(applyDateAndConfidenceReddit(rawReddit, range.from, range.to)))).slice(0, limit);
  const x = sortByScoreAndDate(dedupeX(scoreX(applyDateAndConfidenceX(rawX, range.from, range.to)))).slice(0, limit);
  const web = sortByScoreAndDate(dedupeWeb(scoreWeb(applyDateAndConfidenceWeb(rawWeb, range.from, range.to)))).slice(0, limit);

  const evidenceUrls = new Set<string>([
    ...candidate.sources.map((item) => item.url),
    ...candidate.proofPoints.map((item) => item.sourceUrl),
    ...reddit.map((item) => item.url),
    ...x.map((item) => item.url),
    ...web.map((item) => item.url),
  ]);

  const model = process.env.OPENROUTER_PLAN_MODEL ?? ANALYSIS_MODEL_DEFAULT;
  const response = await openRouterRequest<ChatCompletionResponse>({
    path: "/chat/completions",
    payload: {
      model,
      messages: [
        {
          role: "system",
          content: "You are a strict market-fit analyst. Use only provided evidence and return strict JSON.",
        },
        {
          role: "user",
          content: buildMarketAnalysisPrompt({ candidate, range, reddit, x, web }),
        },
      ],
      temperature: 0.2,
      max_tokens: 2200,
      response_format: { type: "json_object" },
    },
    timeoutMs: 120000,
  });

  addUsage(usageTotals, { ...extractUsage(response as unknown as Record<string, unknown>), calls: 1 });

  const raw = response.choices?.[0]?.message?.content ?? "";
  const parsed = extractJsonObject<RawMarketAnalysis>(raw);

  const subscores = {
    demand: clampScore(parsed?.subscores?.demand, 50),
    urgency: clampScore(parsed?.subscores?.urgency, 50),
    accessibility: clampScore(parsed?.subscores?.accessibility, 50),
    monetization: clampScore(parsed?.subscores?.monetization, 50),
    competitionHeadroom: clampScore(parsed?.subscores?.competitionHeadroom, 50),
  };

  const overallScore = Math.round(
    subscores.demand * 0.3 +
      subscores.urgency * 0.2 +
      subscores.accessibility * 0.15 +
      subscores.monetization * 0.2 +
      subscores.competitionHeadroom * 0.15,
  );

  return {
    overallScore,
    verdict: overallScore >= 75 ? "strong" : overallScore >= 50 ? "moderate" : "weak",
    subscores,
    rationale: toStringArray(parsed?.rationale, 10),
    risks: toStringArray(parsed?.risks, 8),
    sources: normalizeSources(parsed?.sources, evidenceUrls),
    generatedAt: new Date().toISOString(),
    usage: {
      ...usageTotals,
      model,
    },
  };
}

function buildMarketQueries(candidate: NicheCandidate) {
  const seeds = [candidate.name, candidate.problemStatement, candidate.audience, candidate.icp]
    .map((item) => item.trim())
    .filter(Boolean);

  return [
    `${seeds.join(" ")} market demand growth buyer intent last 30 days`,
    `${seeds.join(" ")} customer complaints switching alternatives last 30 days`,
    `${seeds.join(" ")} pricing spend willingness to pay competitors last 30 days`,
  ];
}

function buildMarketAnalysisPrompt({
  candidate,
  range,
  reddit,
  x,
  web,
}: {
  candidate: NicheCandidate;
  range: { from: string; to: string };
  reddit: Array<{ title: string; url: string; date: string | null; subreddit: string }>;
  x: Array<{ text: string; url: string; date: string | null; author_handle: string }>;
  web: Array<{ title: string; url: string; date: string | null; source_domain: string; snippet: string }>;
}) {
  return `Evaluate market fit for this AI product idea using only provided evidence.

Idea:
- Name: ${candidate.name}
- Problem: ${candidate.problemStatement}
- Audience: ${candidate.audience}
- One-liner: ${candidate.oneLiner}

Date window: ${range.from} to ${range.to}

Candidate proof points:
${candidate.proofPoints.map((item) => `- ${item.claim} (${item.sourceUrl})`).join("\n") || "- none"}

Additional Reddit evidence:
${reddit.slice(0, 18).map((item) => `- [${item.date ?? "unknown"}] r/${item.subreddit}: ${item.title} (${item.url})`).join("\n") || "- none"}

Additional X evidence:
${x.slice(0, 18).map((item) => `- [${item.date ?? "unknown"}] @${item.author_handle}: ${item.text} (${item.url})`).join("\n") || "- none"}

Additional Web evidence:
${web.slice(0, 18).map((item) => `- [${item.date ?? "unknown"}] ${item.source_domain}: ${item.title} - ${item.snippet} (${item.url})`).join("\n") || "- none"}

Return strict JSON:
{
  "subscores": {
    "demand": 0,
    "urgency": 0,
    "accessibility": 0,
    "monetization": 0,
    "competitionHeadroom": 0
  },
  "rationale": ["string"],
  "risks": ["string"],
  "sources": [
    {
      "title": "string",
      "url": "https://...",
      "note": "string",
      "type": "general|spending|pain|room",
      "date": "YYYY-MM-DD or null"
    }
  ]
}

Rules:
- Score each subscore from 0 to 100.
- Use only cited URLs from provided evidence.
- Keep rationale specific and evidence-based.
- JSON only.`;
}

function normalizeSources(value: unknown, allowedUrls: Set<string>): NicheSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const typed = entry as RawMarketSource;
      const url = String(typed.url ?? "").trim();
      if (!/^https?:\/\//i.test(url) || !allowedUrls.has(url)) {
        return null;
      }

      const type = typed.type === "spending" || typed.type === "pain" || typed.type === "room" || typed.type === "general"
        ? typed.type
        : "general";

      return {
        title: String(typed.title ?? "Source").trim() || "Source",
        url,
        note: String(typed.note ?? "").trim(),
        type,
        date: normalizeDate(typed.date),
      } satisfies NicheSource;
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .slice(0, 20);
}

function toStringArray(value: unknown, max: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeDate(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function clampScore(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function addUsage(
  target: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; calls: number },
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; calls?: number },
) {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.costUsd += usage.costUsd;
  target.calls += usage.calls ?? 1;
}
