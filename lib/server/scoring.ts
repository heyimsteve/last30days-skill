import { recencyScore } from "@/lib/server/date";
import { DateConfidence, RedditItem, WebItem, XItem } from "@/lib/types";

const WEIGHT_RELEVANCE = 0.45;
const WEIGHT_RECENCY = 0.25;
const WEIGHT_ENGAGEMENT = 0.3;

const WEB_WEIGHT_RELEVANCE = 0.55;
const WEB_WEIGHT_RECENCY = 0.45;
const WEB_SOURCE_PENALTY = 15;
const WEB_VERIFIED_BONUS = 10;
const WEB_NO_DATE_PENALTY = 20;

const DEFAULT_ENGAGEMENT = 35;
const UNKNOWN_ENGAGEMENT_PENALTY = 3;

type ItemWithEngagement = RedditItem | XItem;

function log1pSafe(value: number | null | undefined): number {
  if (value === null || value === undefined || value < 0) {
    return 0;
  }
  return Math.log1p(value);
}

function normalizeTo100(values: Array<number | null | undefined>): Array<number | null> {
  const valid = values.filter((value): value is number => value !== null && value !== undefined);
  if (!valid.length) {
    return values.map(() => null);
  }

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min;

  if (range === 0) {
    return values.map((value) => (value === null || value === undefined ? null : 50));
  }

  return values.map((value) => {
    if (value === null || value === undefined) {
      return null;
    }
    return ((value - min) / range) * 100;
  });
}

function withDatePenalty(score: number, confidence: DateConfidence) {
  if (confidence === "low") {
    return score - 5;
  }
  if (confidence === "med") {
    return score - 2;
  }
  return score;
}

export function scoreReddit(items: RedditItem[]): RedditItem[] {
  if (!items.length) {
    return items;
  }

  const rawEngagement = items.map((item) => {
    if (!item.engagement) {
      return null;
    }
    const score = log1pSafe(item.engagement.score);
    const comments = log1pSafe(item.engagement.num_comments);
    const ratio = (item.engagement.upvote_ratio ?? 0.5) * 10;
    return 0.55 * score + 0.4 * comments + 0.05 * ratio;
  });

  const normalizedEngagement = normalizeTo100(rawEngagement);

  return items.map((item, index) => scoreEngagedItem(item, normalizedEngagement[index], rawEngagement[index]));
}

export function scoreX(items: XItem[]): XItem[] {
  if (!items.length) {
    return items;
  }

  const rawEngagement = items.map((item) => {
    if (!item.engagement) {
      return null;
    }
    const likes = log1pSafe(item.engagement.likes);
    const reposts = log1pSafe(item.engagement.reposts);
    const replies = log1pSafe(item.engagement.replies);
    const quotes = log1pSafe(item.engagement.quotes);
    return 0.55 * likes + 0.25 * reposts + 0.15 * replies + 0.05 * quotes;
  });

  const normalizedEngagement = normalizeTo100(rawEngagement);

  return items.map((item, index) => scoreEngagedItem(item, normalizedEngagement[index], rawEngagement[index]));
}

function scoreEngagedItem<T extends ItemWithEngagement>(
  item: T,
  engagementScore: number | null,
  rawEngagement: number | null,
): T {
  const relevance = Math.round(item.relevance * 100);
  const recency = recencyScore(item.date);
  const engagement = engagementScore === null ? DEFAULT_ENGAGEMENT : Math.round(engagementScore);

  let overall = WEIGHT_RELEVANCE * relevance + WEIGHT_RECENCY * recency + WEIGHT_ENGAGEMENT * engagement;
  if (rawEngagement === null) {
    overall -= UNKNOWN_ENGAGEMENT_PENALTY;
  }
  overall = withDatePenalty(overall, item.date_confidence);

  return {
    ...item,
    subs: {
      relevance,
      recency,
      engagement,
    },
    score: clamp100(overall),
  };
}

export function scoreWeb(items: WebItem[]): WebItem[] {
  return items.map((item) => {
    const relevance = Math.round(item.relevance * 100);
    const recency = recencyScore(item.date);

    let overall = WEB_WEIGHT_RELEVANCE * relevance + WEB_WEIGHT_RECENCY * recency - WEB_SOURCE_PENALTY;
    if (item.date_confidence === "high") {
      overall += WEB_VERIFIED_BONUS;
    } else if (item.date_confidence === "low") {
      overall -= WEB_NO_DATE_PENALTY;
    }

    return {
      ...item,
      subs: {
        relevance,
        recency,
        engagement: 0,
      },
      score: clamp100(overall),
    };
  });
}

function clamp100(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
