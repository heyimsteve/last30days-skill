import { toIsoDate } from "@/lib/server/date";
import { extractJsonObject } from "@/lib/server/openrouter";
import { RedditItem, WebItem, XItem } from "@/lib/types";

interface RawItemsResponse {
  items?: Array<Record<string, unknown>>;
}

const EXCLUDED_WEB_DOMAINS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

export function parseRedditItems(text: string): Omit<RedditItem, "date_confidence" | "subs" | "score" | "source">[] {
  const parsed = extractJsonObject<RawItemsResponse>(text);
  const items = parsed?.items ?? [];

  return items
    .map((item, index) => {
      const url = String(item.url ?? "").trim();
      const title = String(item.title ?? "").trim();
      if (!url || !title || !url.includes("/r/") || !url.includes("/comments/")) {
        return null;
      }

      const subreddit = String(item.subreddit ?? "").replace(/^r\//, "").trim();
      const date = toIsoDate(normalizeDateField(item.date));
      const relevance = clamp01(item.relevance);

      return {
        id: `R${index + 1}`,
        url,
        title: title.slice(0, 300),
        subreddit,
        date,
        relevance,
        why_relevant: String(item.why_relevant ?? "").trim().slice(0, 400),
        engagement: parseRedditEngagement(item.engagement),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export function parseXItems(text: string): Omit<XItem, "date_confidence" | "subs" | "score" | "source">[] {
  const parsed = extractJsonObject<RawItemsResponse>(text);
  const items = parsed?.items ?? [];

  return items
    .map((item, index) => {
      const url = String(item.url ?? "").trim();
      if (!url || (!url.includes("x.com/") && !url.includes("twitter.com/"))) {
        return null;
      }

      const textContent = String(item.text ?? "").trim();
      if (!textContent) {
        return null;
      }

      return {
        id: `X${index + 1}`,
        url,
        text: textContent.slice(0, 500),
        author_handle: String(item.author_handle ?? "").replace(/^@/, "").trim(),
        date: toIsoDate(normalizeDateField(item.date)),
        relevance: clamp01(item.relevance),
        why_relevant: String(item.why_relevant ?? "").trim().slice(0, 400),
        engagement: parseXEngagement(item.engagement),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export function parseWebItems(text: string): Omit<WebItem, "date_confidence" | "subs" | "score" | "source">[] {
  const parsed = extractJsonObject<RawItemsResponse>(text);
  const items = parsed?.items ?? [];

  return items
    .map((item, index) => {
      const url = String(item.url ?? "").trim();
      if (!url) {
        return null;
      }

      const domain = extractDomain(url);
      if (!domain || EXCLUDED_WEB_DOMAINS.has(domain)) {
        return null;
      }

      const title = String(item.title ?? "").trim();
      const snippet = String(item.snippet ?? item.description ?? "").trim();
      if (!title && !snippet) {
        return null;
      }

      const date =
        toIsoDate(normalizeDateField(item.date)) ??
        extractDateFromUrl(url) ??
        extractDateFromText(`${title} ${snippet}`);

      return {
        id: `W${index + 1}`,
        url,
        title: title.slice(0, 220),
        source_domain: domain,
        snippet: snippet.slice(0, 500),
        date,
        relevance: clamp01(item.relevance),
        why_relevant: String(item.why_relevant ?? "").trim().slice(0, 400),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function normalizeDateField(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
}

function parseRedditEngagement(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Record<string, unknown>;
  return {
    score: toNullableInt(item.score),
    num_comments: toNullableInt(item.num_comments),
    upvote_ratio: toNullableFloat(item.upvote_ratio),
  };
}

function parseXEngagement(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Record<string, unknown>;
  return {
    likes: toNullableInt(item.likes),
    reposts: toNullableInt(item.reposts),
    replies: toNullableInt(item.replies),
    quotes: toNullableInt(item.quotes),
  };
}

function toNullableInt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

function toNullableFloat(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp01(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, parsed));
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractDateFromUrl(url: string): string | null {
  const patterns = [
    /\/(\d{4})\/(\d{2})\/(\d{2})\//,
    /\/(\d{4})-(\d{2})-(\d{2})(?:\/|-)/,
    /\/(\d{4})(\d{2})(\d{2})\//,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (!match) {
      continue;
    }

    const [, y, m, d] = match;
    const iso = `${y}-${m}-${d}`;
    return toIsoDate(iso);
  }

  return null;
}

function extractDateFromText(input: string): string | null {
  const isoMatch = input.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return toIsoDate(isoMatch[0]);
  }

  const relativeDaysMatch = input.toLowerCase().match(/\b(\d+)\s+days?\s+ago\b/);
  if (relativeDaysMatch) {
    const days = Number(relativeDaysMatch[1]);
    if (Number.isFinite(days) && days >= 0 && days <= 60) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - days);
      return date.toISOString().slice(0, 10);
    }
  }

  if (/\byesterday\b/i.test(input)) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  return null;
}
