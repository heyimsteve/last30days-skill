export type NicheResearchDepth = "quick" | "default" | "deep";
export type NicheVerdict = "pass" | "watch" | "fail";
export type PlanOutputType = "prd" | "market" | "plan";
export type ValidationEffort = "low" | "medium" | "high";
export type CompetitionLevel = "low" | "medium" | "high";
export type BuildComplexity = "low" | "medium" | "high";
export type EvidenceConfidence = "high" | "med" | "low";
export type PersonaType = "agency-owner" | "operator" | "founder";
export type ProofSourceType = "reddit" | "x" | "web";

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

export interface EvidenceClaim {
  claim: string;
  confidence: EvidenceConfidence;
  sourceUrl?: string;
}

export interface DemandSnapshot {
  trendSummary: string;
  urgencyDrivers: string[];
  buyingSignals: string[];
  searchKeywords: string[];
}

export interface MarketLandscape {
  competitionLevel: CompetitionLevel;
  incumbentTypes: string[];
  whitespace: string[];
  beachheadWedge: string;
}

export interface BusinessModelSnapshot {
  pricingModel: string;
  priceAnchor: string;
  timeToFirstDollar: string;
  expectedGrossMargin: string;
}

export interface GoToMarketSnapshot {
  channels: string[];
  offerHook: string;
  salesMotion: string;
  retentionLoop: string;
}

export interface ExecutionBlueprint {
  buildComplexity: BuildComplexity;
  stackRecommendation: string;
  mvpScope: string[];
  automationLevers: string[];
  moatLevers: string[];
}

export interface ValidationExperiment {
  experiment: string;
  successMetric: string;
  effort: ValidationEffort;
}

export interface SpendingCheck {
  passed: boolean;
  estimatedAnnualSpendUsd: number | null;
  thresholdUsd: number;
  evidence: string[];
  claims: EvidenceClaim[];
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
  claims: EvidenceClaim[];
}

export interface RoomCheck {
  passed: boolean;
  communityName: string;
  platform: string;
  members: number | null;
  engagementSignal: string;
  evidence: string[];
  claims: EvidenceClaim[];
  url: string;
}

export interface CompetitorIntel {
  name: string;
  url: string;
  pricingSummary: string;
  onboardingFriction: string;
  reviewSentiment: string;
  confidence: EvidenceConfidence;
}

export interface PersonaVariant {
  persona: PersonaType;
  primaryPain: string;
  offerVariant: string;
  pricingAngle: string;
  bestChannel: string;
}

export interface OutcomeScores {
  timeToFirstDollarDays: number;
  gtmDifficulty: number;
  integrationComplexity: number;
  weightedScore: number;
}

export interface NicheTrendNews {
  title: string;
  url: string;
  summary: string;
  whyItMatters: string;
  date: string | null;
  confidence: EvidenceConfidence;
}

export interface NicheProofPoint {
  claim: string;
  sourceUrl: string;
  date: string | null;
  sourceType: ProofSourceType;
}

export interface NicheTrendSynthesis {
  summary: string;
  keyTrends: string[];
  unresolvedIssues: string[];
  opportunityGaps: string[];
  citations: NicheProofPoint[];
}

export interface NicheCandidate {
  id: string;
  name: string;
  requestedNiche?: string;
  problemStatement: string;
  oneLiner: string;
  aiBuildAngle: string;
  icp: string;
  audience: string;
  whyNow: string;
  recommendation: string;
  score: number;
  verdict: NicheVerdict;
  demand: DemandSnapshot;
  landscape: MarketLandscape;
  businessModel: BusinessModelSnapshot;
  goToMarket: GoToMarketSnapshot;
  execution: ExecutionBlueprint;
  outcomes: OutcomeScores;
  competitors: CompetitorIntel[];
  personaVariants: PersonaVariant[];
  validationPlan: ValidationExperiment[];
  risks: string[];
  killCriteria: string[];
  proofPoints: NicheProofPoint[];
  checks: {
    spending: SpendingCheck;
    pain: PainCheck;
    room: RoomCheck;
  };
  sources: NicheSource[];
}

export interface NicheResearchResponse {
  query: string;
  queries: string[];
  discoveryMode: boolean;
  mode: NicheResearchDepth;
  range: {
    from: string;
    to: string;
  };
  generatedAt: string;
  candidates: NicheCandidate[];
  runs: Array<{
    niche: string;
    status: "completed" | "failed";
    candidateCount: number;
    elapsedMs: number;
    error?: string;
    trendNews?: NicheTrendNews[];
    trendSynthesis?: NicheTrendSynthesis | null;
  }>;
  stats: {
    total: number;
    passed: number;
    elapsedMs: number;
    runsCompleted: number;
    runsTotal: number;
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
  niche?: string;
  completedRuns?: number;
  totalRuns?: number;
  nicheStatuses?: Array<{
    niche: string;
    state: "pending" | "running" | "completed" | "failed";
    stage: "starting" | "discovering" | "validating" | "complete";
    message: string;
    completedSteps: number;
    totalSteps: number;
    etaMs: number;
    error?: string;
  }>;
}

export interface NichePlanResponse {
  title: string;
  type: PlanOutputType;
  markdown: string;
  generatedAt: string;
  usage: TokenUsageSummary;
}

export interface MarketAnalysisResult {
  overallScore: number;
  verdict: "strong" | "moderate" | "weak";
  subscores: {
    demand: number;
    urgency: number;
    accessibility: number;
    monetization: number;
    competitionHeadroom: number;
  };
  rationale: string[];
  risks: string[];
  sources: NicheSource[];
  generatedAt: string;
  usage: TokenUsageSummary;
}

export interface PromoPackResponse {
  title: string;
  markdown: string;
  generatedAt: string;
  usage: TokenUsageSummary;
}
