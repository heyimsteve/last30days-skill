import { getDateConfidence, isWithinRange } from "@/lib/server/date";
import { RedditItem, SearchItem, WebItem, XItem } from "@/lib/types";

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function getNgrams(input: string, n = 3): Set<string> {
  const normalized = normalizeText(input);
  if (normalized.length < n) {
    return new Set([normalized]);
  }

  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - n; index += 1) {
    grams.add(normalized.slice(index, index + n));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) {
    return 0;
  }

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dedupeBySimilarity<T extends { score: number }>(
  items: T[],
  getText: (item: T) => string,
  threshold = 0.7,
): T[] {
  if (items.length <= 1) {
    return items;
  }

  const grams = items.map((item) => getNgrams(getText(item)));
  const remove = new Set<number>();

  for (let i = 0; i < items.length; i += 1) {
    if (remove.has(i)) {
      continue;
    }

    for (let j = i + 1; j < items.length; j += 1) {
      if (remove.has(j)) {
        continue;
      }

      if (jaccard(grams[i], grams[j]) >= threshold) {
        if (items[i].score >= items[j].score) {
          remove.add(j);
        } else {
          remove.add(i);
          break;
        }
      }
    }
  }

  return items.filter((_, index) => !remove.has(index));
}

export function applyDateAndConfidenceReddit(items: Omit<RedditItem, "score" | "subs" | "date_confidence" | "source">[], from: string, to: string): RedditItem[] {
  return items
    .filter((item) => isWithinRange(item.date, from, to))
    .map((item) => ({
      ...item,
      source: "reddit",
      date_confidence: getDateConfidence(item.date, from, to),
      score: 0,
      subs: { relevance: 0, recency: 0, engagement: 0 },
    }));
}

export function applyDateAndConfidenceX(items: Omit<XItem, "score" | "subs" | "date_confidence" | "source">[], from: string, to: string): XItem[] {
  return items
    .filter((item) => isWithinRange(item.date, from, to))
    .map((item) => ({
      ...item,
      source: "x",
      date_confidence: getDateConfidence(item.date, from, to),
      score: 0,
      subs: { relevance: 0, recency: 0, engagement: 0 },
    }));
}

export function applyDateAndConfidenceWeb(items: Omit<WebItem, "score" | "subs" | "date_confidence" | "source">[], from: string, to: string): WebItem[] {
  return items
    .filter((item) => isWithinRange(item.date, from, to))
    .map((item) => ({
      ...item,
      source: "web",
      date_confidence: getDateConfidence(item.date, from, to),
      score: 0,
      subs: { relevance: 0, recency: 0, engagement: 0 },
    }));
}

export function sortByScoreAndDate<T extends SearchItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    const dateA = Number((a.date ?? "0000-00-00").replaceAll("-", ""));
    const dateB = Number((b.date ?? "0000-00-00").replaceAll("-", ""));
    return dateB - dateA;
  });
}

export function dedupeReddit(items: RedditItem[]) {
  return dedupeBySimilarity(items, (item) => item.title);
}

export function dedupeX(items: XItem[]) {
  return dedupeBySimilarity(items, (item) => item.text);
}

export function dedupeWeb(items: WebItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
