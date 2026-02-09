export type NicheResearchDepth = "quick" | "default" | "deep";
export type NicheVerdict = "pass" | "watch" | "fail";
export type PlanOutputType = "prd" | "plan";

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
  model?: string;
}

export interface NicheSource {
  title: string;
  url: string;
  note: string;
  type: "spending" | "pain" | "room" | "general";
  date?: string | null;
}

export interface SpendingCheck {
  passed: boolean;
  estimatedAnnualSpendUsd: number | null;
  thresholdUsd: number;
  evidence: string[];
  offerings: Array<{
    title: string;
    priceText: string;
    annualPriceUsd: number | null;
    url: string;
  }>;
}

export interface PainCheck {
  passed: boolean;
  recurringComplaintCount: number;
  complaintThemes: string[];
  evidence: string[];
}

export interface RoomCheck {
  passed: boolean;
  communityName: string;
  platform: string;
  members: number | null;
  engagementSignal: string;
  evidence: string[];
  url: string;
}

export interface NicheCandidate {
  id: string;
  name: string;
  oneLiner: string;
  aiBuildAngle: string;
  audience: string;
  whyNow: string;
  recommendation: string;
  score: number;
  verdict: NicheVerdict;
  checks: {
    spending: SpendingCheck;
    pain: PainCheck;
    room: RoomCheck;
  };
  sources: NicheSource[];
}

export interface NicheResearchResponse {
  query: string;
  discoveryMode: boolean;
  mode: NicheResearchDepth;
  range: {
    from: string;
    to: string;
  };
  generatedAt: string;
  candidates: NicheCandidate[];
  stats: {
    total: number;
    passed: number;
    elapsedMs: number;
  };
  usage: TokenUsageSummary;
}

export interface NicheResearchProgressEvent {
  stage: "starting" | "discovering" | "validating" | "complete";
  message: string;
  elapsedMs: number;
  etaMs: number;
  completedSteps: number;
  totalSteps: number;
}

export interface NichePlanResponse {
  title: string;
  type: PlanOutputType;
  markdown: string;
  generatedAt: string;
  usage: TokenUsageSummary;
}
