export type SourceType = "reddit" | "x" | "web" | "youtube";
export type DateConfidence = "high" | "med" | "low";

export interface Engagement {
  score?: number | null;
  num_comments?: number | null;
  upvote_ratio?: number | null;
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  quotes?: number | null;
  views?: number | null;
}

export interface SubScores {
  relevance: number;
  recency: number;
  engagement: number;
}

export interface BaseItem {
  id: string;
  url: string;
  date: string | null;
  date_confidence: DateConfidence;
  relevance: number;
  why_relevant: string;
  subs: SubScores;
  score: number;
}

export interface RedditItem extends BaseItem {
  source: "reddit";
  title: string;
  subreddit: string;
  engagement: Engagement | null;
}

export interface XItem extends BaseItem {
  source: "x";
  text: string;
  author_handle: string;
  engagement: Engagement | null;
}

export interface WebItem extends BaseItem {
  source: "web";
  title: string;
  source_domain: string;
  snippet: string;
}

export interface YouTubeItem extends BaseItem {
  source: "youtube";
  title: string;
  channel: string;
  snippet: string;
  engagement: Engagement | null;
}

export type SearchItem = RedditItem | XItem | WebItem | YouTubeItem;

export interface SearchErrors {
  reddit?: string;
  x?: string;
  web?: string;
  youtube?: string;
  synthesis?: string;
}

export interface SynthesisResult {
  summary: string;
  keyPatterns: string[];
  recommendedFormat: string;
  caveats: string;
  raw: string;
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
  model?: string;
}

export interface UsageReport extends UsageBreakdown {
  byOperation: {
    reddit?: UsageBreakdown;
    x?: UsageBreakdown;
    web?: UsageBreakdown;
    youtube?: UsageBreakdown;
    synthesis?: UsageBreakdown;
  };
}

export interface ResearchResponse {
  topic: string;
  range: {
    from: string;
    to: string;
  };
  sources: SourceType[];
  reddit: RedditItem[];
  x: XItem[];
  web: WebItem[];
  youtube: YouTubeItem[];
  synthesis: SynthesisResult | null;
  errors: SearchErrors;
  stats: {
    total: number;
    reddit: number;
    x: number;
    web: number;
    youtube: number;
    elapsedMs: number;
    generatedAt: string;
  };
  usage: UsageReport;
}
