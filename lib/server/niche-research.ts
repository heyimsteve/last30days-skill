import { getDateRange } from "@/lib/server/date";
import {
  applyDateAndConfidenceReddit,
  applyDateAndConfidenceWeb,
  applyDateAndConfidenceX,
  dedupeReddit,
  dedupeWeb,
  dedupeX,
  sortByScoreAndDate,
} from "@/lib/server/processing";
import { OpenRouterUsage, extractJsonObject, extractUsage, openRouterRequest } from "@/lib/server/openrouter";
import { scoreReddit, scoreWeb, scoreX } from "@/lib/server/scoring";
import { searchReddit, searchWeb, searchX } from "@/lib/server/search";
import { NicheCandidate, NicheResearchDepth, NicheResearchProgressEvent, NicheResearchResponse } from "@/lib/niche-types";
import { RedditItem, WebItem, XItem } from "@/lib/types";

interface NicheResearchInput {
  niche?: string;
  mode: NicheResearchDepth;
}

interface NicheResearchOptions {
  onProgress?: (event: NicheResearchProgressEvent) => void;
}

interface RawNicheCandidate {
  name?: unknown;
  oneLiner?: unknown;
  aiBuildAngle?: unknown;
  audience?: unknown;
  whyNow?: unknown;
  recommendation?: unknown;
  score?: unknown;
  verdict?: unknown;
  checks?: {
    spending?: {
      passed?: unknown;
      estimatedAnnualSpendUsd?: unknown;
      thresholdUsd?: unknown;
      evidence?: unknown;
      offerings?: unknown;
    };
    pain?: {
      passed?: unknown;
      recurringComplaintCount?: unknown;
      complaintThemes?: unknown;
      evidence?: unknown;
    };
    room?: {
      passed?: unknown;
      communityName?: unknown;
      platform?: unknown;
      members?: unknown;
      engagementSignal?: unknown;
      evidence?: unknown;
      url?: unknown;
    };
  };
  sources?: unknown;
}

interface RawCandidatesOutput {
  candidates?: RawNicheCandidate[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
}

const VALIDATE_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";

type SearchResultShape = {
  reddit: Awaited<ReturnType<typeof searchReddit>>["items"];
  x: Awaited<ReturnType<typeof searchX>>["items"];
  web: Awaited<ReturnType<typeof searchWeb>>["items"];
};

const MODE_CONFIG: Record<
  NicheResearchDepth,
  {
    candidateCount: number;
    perSourceLimit: number;
    validateMaxTokens: number;
    estimateMs: number;
    discoveryQueries: string[];
  }
> = {
  quick: {
    candidateCount: 4,
    perSourceLimit: 10,
    validateMaxTokens: 2600,
    estimateMs: 480000,
    discoveryQueries: [
      "businesses paying for consultants/tools while complaining about repetitive manual workflows",
    ],
  },
  default: {
    candidateCount: 7,
    perSourceLimit: 16,
    validateMaxTokens: 4200,
    estimateMs: 600000,
    discoveryQueries: [
      "businesses paying for consultants/tools while complaining about repetitive manual workflows",
      "reddit and x posts where people say frustrated wish there was or looking for better tools in operations",
    ],
  },
  deep: {
    candidateCount: 10,
    perSourceLimit: 24,
    validateMaxTokens: 5800,
    estimateMs: 660000,
    discoveryQueries: [
      "businesses paying for consultants/tools while complaining about repetitive manual workflows",
      "reddit and x posts where people say frustrated wish there was or looking for better tools in operations",
      "high-spend niches in healthcare insurance legal finance ecommerce with active communities and unresolved pain",
    ],
  },
};

export async function runNicheResearch(
  input: NicheResearchInput,
  options: NicheResearchOptions = {},
): Promise<NicheResearchResponse> {
  const startedAt = Date.now();
  const niche = input.niche?.trim() ?? "";
  const mode = input.mode;
  const config = MODE_CONFIG[mode];
  const range = getDateRange(30);
  const onProgress = options.onProgress;

  const usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const queries = niche ? buildFocusedQueries(niche, mode) : config.discoveryQueries;
  const totalSteps = queries.length + 2;
  let completedSteps = 0;

  const emit = (stage: NicheResearchProgressEvent["stage"], message: string) => {
    if (!onProgress) {
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    onProgress({
      stage,
      message,
      elapsedMs,
      etaMs: Math.max(0, config.estimateMs - elapsedMs),
      completedSteps,
      totalSteps,
    });
  };

  emit("starting", "Preparing multi-source niche validation pipeline...");

  const allRawReddit: SearchResultShape["reddit"] = [];
  const allRawX: SearchResultShape["x"] = [];
  const allRawWeb: SearchResultShape["web"] = [];

  for (const query of queries) {
    emit("discovering", `Searching Reddit, X, and Web for: ${query}`);

    const searchResult = await runThreeSourceSearch({
      query,
      mode,
      fromDate: range.from,
      toDate: range.to,
    });

    addUsage(usageTotals, searchResult.usage);
    allRawReddit.push(...searchResult.items.reddit);
    allRawX.push(...searchResult.items.x);
    allRawWeb.push(...searchResult.items.web);

    completedSteps += 1;
  }

  const reddit = sortByScoreAndDate(
    dedupeReddit(scoreReddit(applyDateAndConfidenceReddit(allRawReddit, range.from, range.to))),
  ).slice(0, config.perSourceLimit);

  const x = sortByScoreAndDate(
    dedupeX(scoreX(applyDateAndConfidenceX(allRawX, range.from, range.to))),
  ).slice(0, config.perSourceLimit);

  const web = sortByScoreAndDate(
    dedupeWeb(scoreWeb(applyDateAndConfidenceWeb(allRawWeb, range.from, range.to))),
  ).slice(0, config.perSourceLimit);

  completedSteps += 1;
  emit("validating", "Validating candidates against spending, pain, and launch room checks...");

  let candidates = await generateValidatedCandidates({
    niche,
    mode,
    range,
    candidateCount: config.candidateCount,
    reddit,
    x,
    web,
  });

  addUsage(usageTotals, candidates.usage);

  if (!candidates.items.length && (reddit.length || x.length || web.length)) {
    const retry = await generateValidatedCandidates({
      niche,
      mode,
      range,
      candidateCount: config.candidateCount,
      reddit,
      x,
      web,
      retryMode: true,
    });

    addUsage(usageTotals, retry.usage);
    candidates = retry;
  }

  const normalized = candidates.items
    .map((candidate, index) => normalizeCandidate(candidate, index))
    .filter((candidate) => isLaunchReadyCandidate(candidate));

  const finalCandidates = dedupeCandidates(normalized);

  completedSteps += 1;
  emit("complete", "Niche validation complete.");

  return {
    query: niche,
    discoveryMode: !niche,
    mode,
    range,
    generatedAt: new Date().toISOString(),
    candidates: finalCandidates,
    stats: {
      total: finalCandidates.length,
      passed: finalCandidates.length,
      elapsedMs: Date.now() - startedAt,
    },
    usage: {
      ...usageTotals,
      model: process.env.OPENROUTER_NICHE_MODEL ?? VALIDATE_MODEL_DEFAULT,
    },
  };
}

async function runThreeSourceSearch({
  query,
  mode,
  fromDate,
  toDate,
}: {
  query: string;
  mode: NicheResearchDepth;
  fromDate: string;
  toDate: string;
}) {
  const [redditResult, xResult, webResult] = await Promise.allSettled([
    searchReddit({ topic: query, depth: mode, fromDate, toDate }),
    searchX({ topic: query, depth: mode, fromDate, toDate }),
    searchWeb({ topic: query, depth: mode, fromDate, toDate }),
  ]);

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const items: SearchResultShape = {
    reddit: redditResult.status === "fulfilled" ? redditResult.value.items : [],
    x: xResult.status === "fulfilled" ? xResult.value.items : [],
    web: webResult.status === "fulfilled" ? webResult.value.items : [],
  };

  if (redditResult.status === "fulfilled") {
    addUsage(usage, { ...redditResult.value.usage, calls: 1 });
  }
  if (xResult.status === "fulfilled") {
    addUsage(usage, { ...xResult.value.usage, calls: 1 });
  }
  if (webResult.status === "fulfilled") {
    addUsage(usage, { ...webResult.value.usage, calls: 1 });
  }

  return { items, usage };
}

async function generateValidatedCandidates({
  niche,
  mode,
  range,
  candidateCount,
  reddit,
  x,
  web,
  retryMode = false,
}: {
  niche: string;
  mode: NicheResearchDepth;
  range: { from: string; to: string };
  candidateCount: number;
  reddit: RedditItem[];
  x: XItem[];
  web: WebItem[];
  retryMode?: boolean;
}) {
  const model = process.env.OPENROUTER_NICHE_MODEL ?? VALIDATE_MODEL_DEFAULT;
  const prompt = buildValidationPrompt({
    niche,
    mode,
    range,
    candidateCount,
    reddit,
    x,
    web,
    retryMode,
  });

  const response = await openRouterRequest<ChatCompletionResponse>({
    path: "/chat/completions",
    payload: {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a niche validation analyst. Use only provided evidence. Return strict JSON. No markdown. No prose.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: retryMode ? 0.35 : 0.2,
      max_tokens: retryMode ? 5200 : 4200,
      response_format: { type: "json_object" },
    },
    timeoutMs: 120000,
  });

  const raw = response.choices?.[0]?.message?.content ?? "";
  const parsed = extractJsonObject<RawCandidatesOutput>(raw);

  return {
    items: Array.isArray(parsed?.candidates) ? parsed.candidates : [],
    usage: {
      ...extractUsage(response as unknown as Record<string, unknown>),
      calls: 1,
    },
  };
}

function buildValidationPrompt({
  niche,
  mode,
  range,
  candidateCount,
  reddit,
  x,
  web,
  retryMode,
}: {
  niche: string;
  mode: NicheResearchDepth;
  range: { from: string; to: string };
  candidateCount: number;
  reddit: RedditItem[];
  x: XItem[];
  web: WebItem[];
  retryMode: boolean;
}) {
  const scope = niche
    ? `User niche focus: ${niche}. Propose validated sub-niches or specific slices within this market.`
    : "No niche provided. Discover any niches in the evidence that pass all three checks.";

  return `Date window is fixed: ${range.from} to ${range.to} (inclusive). Use only the evidence below.
Research depth: ${mode}.
${scope}

Goal:
- Return up to ${candidateCount} niches that pass ALL three checks.
- If none pass, return {"candidates": []}.

Checks:
1) Spending: evidence that buyers spend >= $500/year on this problem via consultants, courses, or tools.
2) Pain: recurring complaint appears 3+ times.
3) Room: active launch community with under 50k members and real engagement.

${retryMode ? "Retry mode: infer conservative but concrete estimates from provided evidence when exact values are missing; still require all three checks to pass." : "Use strict evidence extraction from provided items."}

Reddit evidence:
${compactReddit(reddit)}

X evidence:
${compactX(x)}

Web evidence:
${compactWeb(web)}

Return strict JSON:
{
  "candidates": [
    {
      "name": "string",
      "oneLiner": "string",
      "aiBuildAngle": "string",
      "audience": "string",
      "whyNow": "string",
      "recommendation": "string",
      "score": 0,
      "verdict": "pass",
      "checks": {
        "spending": {
          "passed": true,
          "estimatedAnnualSpendUsd": 0,
          "thresholdUsd": 500,
          "evidence": ["string"],
          "offerings": [
            {
              "title": "string",
              "priceText": "string",
              "annualPriceUsd": 0,
              "url": "https://..."
            }
          ]
        },
        "pain": {
          "passed": true,
          "recurringComplaintCount": 0,
          "complaintThemes": ["string"],
          "evidence": ["string"]
        },
        "room": {
          "passed": true,
          "communityName": "string",
          "platform": "Reddit|Discord|Facebook|Slack|Forum|X",
          "members": 0,
          "engagementSignal": "string",
          "evidence": ["string"],
          "url": "https://..."
        }
      },
      "sources": [
        {
          "title": "string",
          "url": "https://...",
          "note": "string",
          "type": "spending|pain|room|general",
          "date": "YYYY-MM-DD"
        }
      ]
    }
  ]
}

Rules:
- JSON only.
- Use only URLs present in evidence above.
- source.date must be between ${range.from} and ${range.to}.
- Do not output candidates that fail any check.`;
}

function compactReddit(items: RedditItem[]) {
  if (!items.length) {
    return "- none";
  }

  return items
    .slice(0, 24)
    .map((item) => {
      const score = item.engagement?.score ?? "?";
      const comments = item.engagement?.num_comments ?? "?";
      return `- [${item.date ?? "unknown"}] [score:${score} comments:${comments}] r/${item.subreddit} ${item.title} (${item.url})`;
    })
    .join("\n");
}

function compactX(items: XItem[]) {
  if (!items.length) {
    return "- none";
  }

  return items
    .slice(0, 24)
    .map((item) => {
      const likes = item.engagement?.likes ?? 0;
      const replies = item.engagement?.replies ?? 0;
      return `- [${item.date ?? "unknown"}] [likes:${likes} replies:${replies}] @${item.author_handle} ${item.text} (${item.url})`;
    })
    .join("\n");
}

function compactWeb(items: WebItem[]) {
  if (!items.length) {
    return "- none";
  }

  return items
    .slice(0, 24)
    .map((item) => `- [${item.date ?? "unknown"}] [${item.source_domain}] ${item.title} - ${item.snippet} (${item.url})`)
    .join("\n");
}

function buildFocusedQueries(niche: string, mode: NicheResearchDepth) {
  if (mode === "quick") {
    return [niche];
  }

  if (mode === "default") {
    return [niche, `${niche} consultant tool course pricing complaints community`];
  }

  return [
    niche,
    `${niche} consultant tool course pricing complaints community`,
    `${niche} frustrated wish there was looking for reddit discord forum`,
  ];
}

function normalizeCandidate(raw: RawNicheCandidate, index: number): NicheCandidate {
  const name = toSafeString(raw.name, `Niche ${index + 1}`);

  const thresholdUsd = Math.max(500, toNullableNumber(raw.checks?.spending?.thresholdUsd) ?? 500);
  const spendingEstimate = toNullableNumber(raw.checks?.spending?.estimatedAnnualSpendUsd);
  const spendingEvidence = toStringArray(raw.checks?.spending?.evidence, 8);
  const offerings = normalizeOfferings(raw.checks?.spending?.offerings);
  const hasPriceSignal =
    (spendingEstimate !== null && spendingEstimate >= thresholdUsd) ||
    offerings.some((offering) => (offering.annualPriceUsd ?? 0) >= thresholdUsd);
  const spendingPassed = toBoolean(raw.checks?.spending?.passed) && spendingEvidence.length > 0 && hasPriceSignal;

  const painEvidence = toStringArray(raw.checks?.pain?.evidence, 8);
  const recurringComplaintCount = toNullableNumber(raw.checks?.pain?.recurringComplaintCount) ?? 0;
  const complaintThemes = toStringArray(raw.checks?.pain?.complaintThemes, 8);
  const painPassed = toBoolean(raw.checks?.pain?.passed) && recurringComplaintCount >= 3 && painEvidence.length > 0 && complaintThemes.length > 0;

  const roomEvidence = toStringArray(raw.checks?.room?.evidence, 8);
  const communityMembers = toNullableNumber(raw.checks?.room?.members);
  const roomUrl = toSafeString(raw.checks?.room?.url, "");
  const engagementSignal = toSafeString(raw.checks?.room?.engagementSignal, "");
  const roomPassed =
    toBoolean(raw.checks?.room?.passed) &&
    roomEvidence.length > 0 &&
    hasValidUrl(roomUrl) &&
    Boolean(engagementSignal) &&
    (communityMembers === null || (communityMembers > 0 && communityMembers < 50000));

  const passCount = [spendingPassed, painPassed, roomPassed].filter(Boolean).length;

  return {
    id: createCandidateId(name, index),
    name,
    oneLiner: toSafeString(raw.oneLiner, ""),
    aiBuildAngle: toSafeString(raw.aiBuildAngle, ""),
    audience: toSafeString(raw.audience, ""),
    whyNow: toSafeString(raw.whyNow, ""),
    recommendation: toSafeString(raw.recommendation, ""),
    score: clampScore(raw.score),
    verdict: normalizeVerdict(raw.verdict, passCount),
    checks: {
      spending: {
        passed: spendingPassed,
        estimatedAnnualSpendUsd: spendingEstimate,
        thresholdUsd,
        evidence: spendingEvidence,
        offerings,
      },
      pain: {
        passed: painPassed,
        recurringComplaintCount,
        complaintThemes,
        evidence: painEvidence,
      },
      room: {
        passed: roomPassed,
        communityName: toSafeString(raw.checks?.room?.communityName, "Unknown community"),
        platform: toSafeString(raw.checks?.room?.platform, "Community"),
        members: communityMembers,
        engagementSignal: engagementSignal || "No engagement signal provided.",
        evidence: roomEvidence,
        url: roomUrl,
      },
    },
    sources: normalizeSources(raw.sources),
  };
}

function normalizeOfferings(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const typed = item as {
        title?: unknown;
        priceText?: unknown;
        annualPriceUsd?: unknown;
        url?: unknown;
      };

      const url = toSafeString(typed.url, "");
      if (!hasValidUrl(url)) {
        return null;
      }

      const priceText = toSafeString(typed.priceText, "Price not listed");
      const annualPriceUsd = toNullableNumber(typed.annualPriceUsd) ?? inferAnnualPriceFromText(priceText);

      return {
        title: toSafeString(typed.title, "Unnamed offer"),
        priceText,
        annualPriceUsd,
        url,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 8);
}

function normalizeSources(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const typed = item as {
        title?: unknown;
        url?: unknown;
        note?: unknown;
        type?: unknown;
        date?: unknown;
      };

      const url = toSafeString(typed.url, "");
      if (!hasValidUrl(url)) {
        return null;
      }

      const sourceType: NicheCandidate["sources"][number]["type"] =
        typed.type === "spending" || typed.type === "pain" || typed.type === "room" || typed.type === "general"
          ? typed.type
          : "general";

      return {
        title: toSafeString(typed.title, "Source"),
        url,
        note: toSafeString(typed.note, ""),
        type: sourceType,
        date: toNullableDateString(typed.date),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 18);
}

function isLaunchReadyCandidate(candidate: NicheCandidate) {
  return candidate.checks.spending.passed && candidate.checks.pain.passed && candidate.checks.room.passed;
}

function dedupeCandidates(candidates: NicheCandidate[]) {
  const seen = new Set<string>();
  const result: NicheCandidate[] = [];

  for (const candidate of candidates) {
    const key = candidate.name.toLowerCase().trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }

  return result;
}

function inferAnnualPriceFromText(text: string): number | null {
  const lowered = text.toLowerCase();
  const match = lowered.match(/\$\s*(\d+(?:[\.,]\d+)?)/);
  if (!match) {
    return null;
  }

  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) {
    return null;
  }

  if (/(per\s*month|\/mo\b|monthly)/.test(lowered)) {
    return Math.round(amount * 12);
  }

  if (/(per\s*year|\/yr\b|annually|annual)/.test(lowered)) {
    return Math.round(amount);
  }

  return Math.round(amount);
}

function addUsage(
  target: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; calls: number },
  usage: OpenRouterUsage & { calls?: number },
) {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.costUsd += usage.costUsd;
  target.calls += usage.calls ?? 1;
}

function createCandidateId(name: string, index: number) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

  return `${slug || "niche"}-${index + 1}`;
}

function hasValidUrl(value: string) {
  return /^https?:\/\//i.test(value);
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

function toNullableDateString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  return text;
}

function clampScore(value: unknown) {
  const raw = toNullableNumber(value) ?? 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function toSafeString(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function toNullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: unknown) {
  return value === true;
}

function normalizeVerdict(value: unknown, passCount: number): NicheCandidate["verdict"] {
  if (value === "pass" || value === "watch" || value === "fail") {
    return value;
  }

  if (passCount === 3) {
    return "pass";
  }

  if (passCount === 2) {
    return "watch";
  }

  return "fail";
}
