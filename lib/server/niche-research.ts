import { getDateRange } from "@/lib/server/date";
import {
  NicheResearchCheckpoint,
  loadNicheCheckpoint,
  saveNicheRecoveryArtifact,
  saveNicheCheckpoint,
} from "@/lib/server/niche-checkpoint";
import {
  applyDateAndConfidenceReddit,
  applyDateAndConfidenceWeb,
  applyDateAndConfidenceX,
  dedupeReddit,
  dedupeWeb,
  dedupeX,
  sortByScoreAndDate,
} from "@/lib/server/processing";
import {
  OpenRouterUsage,
  extractJsonObject,
  extractTextFromOpenRouterResponse,
  extractUsage,
  openRouterRequest,
} from "@/lib/server/openrouter";
import { scoreReddit, scoreWeb, scoreX } from "@/lib/server/scoring";
import { searchReddit, searchWeb, searchX } from "@/lib/server/search";
import {
  NicheCandidate,
  NicheProofPoint,
  NicheResearchDepth,
  NicheResearchProgressEvent,
  NicheResearchResponse,
  NicheSource,
  NicheTrendNews,
  NicheTrendSynthesis,
} from "@/lib/niche-types";
import { RedditItem, WebItem, XItem } from "@/lib/types";

interface NicheResearchInput {
  niche?: string;
  mode: NicheResearchDepth;
}

interface NicheResearchOptions {
  onProgress?: (event: NicheResearchProgressEvent) => void;
  abortSignal?: AbortSignal;
  resumeKey?: string;
}

interface NicheBatchResearchInput {
  niches: string[];
  mode: NicheResearchDepth;
}

interface RawNicheCandidate {
  name?: unknown;
  problemStatement?: unknown;
  oneLiner?: unknown;
  aiBuildAngle?: unknown;
  icp?: unknown;
  audience?: unknown;
  whyNow?: unknown;
  recommendation?: unknown;
  score?: unknown;
  verdict?: unknown;
  proofPoints?: unknown;
  demand?: {
    trendSummary?: unknown;
    urgencyDrivers?: unknown;
    buyingSignals?: unknown;
    searchKeywords?: unknown;
  };
  landscape?: {
    competitionLevel?: unknown;
    incumbentTypes?: unknown;
    whitespace?: unknown;
    beachheadWedge?: unknown;
  };
  businessModel?: {
    pricingModel?: unknown;
    priceAnchor?: unknown;
    timeToFirstDollar?: unknown;
    expectedGrossMargin?: unknown;
  };
  goToMarket?: {
    channels?: unknown;
    offerHook?: unknown;
    salesMotion?: unknown;
    retentionLoop?: unknown;
  };
  execution?: {
    buildComplexity?: unknown;
    stackRecommendation?: unknown;
    mvpScope?: unknown;
    automationLevers?: unknown;
    moatLevers?: unknown;
  };
  outcomes?: {
    timeToFirstDollarDays?: unknown;
    gtmDifficulty?: unknown;
    integrationComplexity?: unknown;
  };
  personaVariants?: unknown;
  validationPlan?: unknown;
  risks?: unknown;
  killCriteria?: unknown;
  checks?: {
    spending?: {
      passed?: unknown;
      estimatedAnnualSpendUsd?: unknown;
      thresholdUsd?: unknown;
      evidence?: unknown;
      claims?: unknown;
      offerings?: unknown;
    };
    pain?: {
      passed?: unknown;
      recurringComplaintCount?: unknown;
      complaintThemes?: unknown;
      evidence?: unknown;
      claims?: unknown;
    };
    room?: {
      passed?: unknown;
      communityName?: unknown;
      platform?: unknown;
      members?: unknown;
      engagementSignal?: unknown;
      evidence?: unknown;
      claims?: unknown;
      url?: unknown;
    };
  };
  sources?: unknown;
}

interface RawProofPoint {
  claim?: unknown;
  sourceUrl?: unknown;
  date?: unknown;
  sourceType?: unknown;
}

interface RawCompetitor {
  name?: unknown;
  url?: unknown;
  pricingSummary?: unknown;
  onboardingFriction?: unknown;
  reviewSentiment?: unknown;
  confidence?: unknown;
}

interface RawCompetitorOutput {
  competitors?: RawCompetitor[];
}

interface RawTrendSynthesis {
  summary?: unknown;
  keyTrends?: unknown;
  unresolvedIssues?: unknown;
  opportunityGaps?: unknown;
  citations?: unknown;
}

interface RawCandidatesOutput {
  candidates?: RawNicheCandidate[];
}

interface EvidenceReference {
  sourceType: "reddit" | "x" | "web";
  url: string;
  date: string | null;
  headline: string;
}

interface EvidenceIndex {
  refs: EvidenceReference[];
  byMatchKey: Map<string, EvidenceReference>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
}

interface OpenRouterResponsesResponse {
  output?: unknown;
  choices?: unknown;
  usage?: Record<string, unknown>;
}

const VALIDATE_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";
const COMPETITOR_MODEL_DEFAULT = "openai/gpt-5.2:online";
const TREND_SYNTH_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";

const MODE_CONFIG: Record<
  NicheResearchDepth,
  {
    candidateCount: number;
    perSourceLimit: number;
    validateMaxTokens: number;
    estimateMs: number;
  }
> = {
  quick: {
    candidateCount: 4,
    perSourceLimit: 10,
    validateMaxTokens: 2600,
    estimateMs: 360000,
  },
  default: {
    candidateCount: 7,
    perSourceLimit: 16,
    validateMaxTokens: 4200,
    estimateMs: 900000,
  },
  deep: {
    candidateCount: 10,
    perSourceLimit: 24,
    validateMaxTokens: 5800,
    estimateMs: 1320000,
  },
};

export async function runNicheResearch(
  input: NicheResearchInput,
  options: NicheResearchOptions = {},
): Promise<NicheResearchResponse> {
  const niche = input.niche?.trim() ?? "";
  const mode = input.mode;
  const config = MODE_CONFIG[mode];
  const range = getDateRange(30);
  const onProgress = options.onProgress;
  const abortSignal = options.abortSignal;
  const resumeKey = options.resumeKey?.trim() ?? "";

  throwIfAborted(abortSignal);

  const queries = niche ? buildFocusedQueries(niche) : buildDiscoveryQueries();
  const totalSteps = queries.length + 4;
  const resumeCheckpoint = resumeKey ? await loadNicheCheckpoint(resumeKey) : null;
  const canResume =
    Boolean(resumeCheckpoint) &&
    resumeCheckpoint?.mode === mode &&
    resumeCheckpoint?.niche === niche &&
    resumeCheckpoint?.totalSteps === totalSteps &&
    sameStringArray(resumeCheckpoint?.queries ?? [], queries);

  const checkpoint = canResume
    ? (resumeCheckpoint as NicheResearchCheckpoint)
    : createEmptyCheckpoint({
        niche,
        mode,
        range,
        queries,
        totalSteps,
      });

  const startedAt = checkpoint.startedAt;
  const usageTotals = { ...checkpoint.usageTotals };
  let completedSteps = checkpoint.completedSteps;

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

  emit(
    "starting",
    canResume
      ? `Resuming ${niche || "auto-discovery"} from step ${Math.min(completedSteps, totalSteps)}/${totalSteps}.`
      : niche
        ? `Preparing trend-first research for ${niche}.`
        : "Preparing auto-discovery trend-first research.",
  );

  if (checkpoint.finalReport) {
    emit("complete", "Loaded completed research checkpoint.");
    return checkpoint.finalReport;
  }

  const allRawReddit: Awaited<ReturnType<typeof searchReddit>>["items"] = [...checkpoint.allRaw.reddit];
  const allRawX: Awaited<ReturnType<typeof searchX>>["items"] = [...checkpoint.allRaw.x];
  const allRawWeb: Awaited<ReturnType<typeof searchWeb>>["items"] = [...checkpoint.allRaw.web];

  let completedQueryCount = Math.min(checkpoint.completedQueryCount, queries.length);
  let finalCandidates = checkpoint.finalCandidates ? [...checkpoint.finalCandidates] : null;
  let enriched = checkpoint.enrichedCandidates ? [...checkpoint.enrichedCandidates] : null;
  let trendNews = checkpoint.trendNews ? [...checkpoint.trendNews] : null;
  let trendSynthesis: NicheTrendSynthesis | null = null;

  const recoveryNotes = new Set<string>();

  while (completedQueryCount < queries.length) {
    throwIfAborted(abortSignal);

    const index = completedQueryCount;
    const query = queries[index];
    emit("discovering", describeQueryStep({ niche, query, index, total: queries.length }));

    const searchResult = await runThreeSourceSearch({
      query,
      mode,
      fromDate: range.from,
      toDate: range.to,
      signal: abortSignal,
    });
    throwIfAborted(abortSignal);

    addUsage(usageTotals, searchResult.usage);
    allRawReddit.push(...searchResult.items.reddit);
    allRawX.push(...searchResult.items.x);
    allRawWeb.push(...searchResult.items.web);

    completedQueryCount += 1;
    completedSteps += 1;

    emit(
      "discovering",
      `Collected Reddit/X/Web trend signals (${completedQueryCount}/${queries.length} queries).`,
    );

    await persistCheckpoint({
      resumeKey,
      checkpoint: {
        ...checkpoint,
        completedQueryCount,
        completedSteps,
        usageTotals: { ...usageTotals },
        allRaw: {
          reddit: [...allRawReddit],
          x: [...allRawX],
          web: [...allRawWeb],
        },
        trendNews: trendNews ? [...trendNews] : null,
      },
    });
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
  const evidenceIndex = createEvidenceIndex({ reddit, x, web });

  completedSteps += 1;
  emit("validating", "Synthesizing latest 30-day trends and unresolved issues with Claude...");

  try {
    const synthesisRun = await synthesizeTrendEvidence({
      niche: niche || "cross-niche discovery",
      range,
      evidenceIndex,
      signal: abortSignal,
    });
    trendSynthesis = synthesisRun.synthesis;
    addUsage(usageTotals, synthesisRun.usage);
  } catch (error) {
    if (isAbortLikeError(error) || abortSignal?.aborted) {
      throw toAbortError(error);
    }
    trendSynthesis = emptyTrendSynthesis();
    const message = `Trend synthesis degraded (${toRecoveryReason(error)}). Continuing with direct evidence.`;
    recoveryNotes.add(message);
    emit("validating", message);
  }

  if (!trendSynthesis || isWeakTrendSynthesis(trendSynthesis)) {
    const heuristic = buildHeuristicTrendSynthesis({
      niche: niche || "cross-niche discovery",
      evidenceIndex,
      range,
    });
    trendSynthesis = heuristic;
    recoveryNotes.add("Applied deterministic trend synthesis from collected evidence.");
  }

  if (!finalCandidates) {
    completedSteps += 1;
    emit("validating", "Generating provable AI product ideas from synthesized trends...");

    try {
      let candidates = await generateValidatedCandidates({
        niche,
        mode,
        range,
        candidateCount: config.candidateCount,
        reddit,
        x,
        web,
        trendSynthesis: trendSynthesis ?? emptyTrendSynthesis(),
        retryMode: false,
        signal: abortSignal,
      });
      throwIfAborted(abortSignal);
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
          trendSynthesis: trendSynthesis ?? emptyTrendSynthesis(),
          retryMode: true,
          signal: abortSignal,
        });
        throwIfAborted(abortSignal);
        addUsage(usageTotals, retry.usage);
        candidates = retry;
      }

      const normalized = candidates.items
        .map((candidate, index) => normalizeCandidate(candidate, index, niche || null, evidenceIndex));

      const launchReady = normalized.filter((candidate) => isLaunchReadyCandidate(candidate));
      if (launchReady.length) {
        finalCandidates = dedupeCandidates(launchReady);
      } else {
        const evidenceBacked = normalized.filter((candidate) => isEvidenceBackedCandidate(candidate));
        if (evidenceBacked.length) {
          recoveryNotes.add("No strict pass candidates survived. Returned evidence-backed watchlist candidates.");
          finalCandidates = dedupeCandidates(evidenceBacked);
        } else {
          finalCandidates = buildFallbackCandidatesFromEvidence({
            niche,
            requestedNiche: niche || null,
            trendSynthesis: trendSynthesis ?? emptyTrendSynthesis(),
            evidenceIndex,
            candidateCount: Math.min(config.candidateCount, 2),
          });
          if (finalCandidates.length) {
            recoveryNotes.add("Model returned no usable candidates. Generated deterministic evidence-backed fallback ideas.");
          }
        }
      }
    } catch (error) {
      if (isAbortLikeError(error) || abortSignal?.aborted) {
        throw toAbortError(error);
      }

      finalCandidates = [];
      const message = `Candidate validation degraded (${toRecoveryReason(error)}). Returning partial run output.`;
      recoveryNotes.add(message);
      emit("validating", message);
    }

    await persistCheckpoint({
      resumeKey,
      checkpoint: {
        ...checkpoint,
        completedQueryCount,
        completedSteps,
        usageTotals: { ...usageTotals },
        allRaw: {
          reddit: [...allRawReddit],
          x: [...allRawX],
          web: [...allRawWeb],
        },
        finalCandidates: [...finalCandidates],
        trendNews: trendNews ? [...trendNews] : null,
      },
    });
  }

  if (!enriched) {
    completedSteps += 1;
    const quickModeCanSkipCompetitorStep =
      mode === "quick" && (finalCandidates ?? []).every((candidate) => candidate.verdict !== "pass");

    if (quickModeCanSkipCompetitorStep) {
      enriched = [...(finalCandidates ?? [])];
      recoveryNotes.add("Skipped competitor enrichment in quick mode for non-pass candidates.");
      emit("validating", "Skipped competitor enrichment for quick-mode watchlist candidates.");
    } else {
      emit("validating", "Running competitor intelligence enrichment...");

      try {
        const enrichedCandidates = await enrichCandidates({
          candidates: finalCandidates ?? [],
          range,
          mode,
          signal: abortSignal,
        });
        throwIfAborted(abortSignal);
        addUsage(usageTotals, enrichedCandidates.usage);
        enriched = enrichedCandidates.items;
      } catch (error) {
        if (isAbortLikeError(error) || abortSignal?.aborted) {
          throw toAbortError(error);
        }
        enriched = [...(finalCandidates ?? [])];
        const message = `Competitor enrichment degraded (${toRecoveryReason(error)}). Continuing with validated candidates.`;
        recoveryNotes.add(message);
        emit("validating", message);
      }
    }

    await persistCheckpoint({
      resumeKey,
      checkpoint: {
        ...checkpoint,
        completedQueryCount,
        completedSteps,
        usageTotals: { ...usageTotals },
        allRaw: {
          reddit: [...allRawReddit],
          x: [...allRawX],
          web: [...allRawWeb],
        },
        finalCandidates: [...(finalCandidates ?? [])],
        enrichedCandidates: [...enriched],
        trendNews: trendNews ? [...trendNews] : null,
      },
    });
  }

  const readyFinalCandidates = finalCandidates ?? [];
  const readyEnrichedCandidates = enriched ?? readyFinalCandidates;
  if (!trendNews) {
    trendNews = buildTrendNewsFromEvidence({
      trendSynthesis: trendSynthesis ?? emptyTrendSynthesis(),
      evidenceIndex,
    });
  }

  const rankedCandidates = rankCandidatesByOutcomes(readyEnrichedCandidates);

  completedSteps += 1;
  emit("complete", "Niche validation complete.");

  const recoveryMessages = Array.from(recoveryNotes);
  const baseCheckpoint: NicheResearchCheckpoint = {
    ...checkpoint,
    completedQueryCount,
    completedSteps: totalSteps,
    usageTotals: { ...usageTotals },
    allRaw: {
      reddit: [...allRawReddit],
      x: [...allRawX],
      web: [...allRawWeb],
    },
    finalCandidates: [...readyFinalCandidates],
    enrichedCandidates: [...readyEnrichedCandidates],
    trendNews: trendNews ?? [],
    finalReport: null,
    updatedAt: new Date().toISOString(),
  };

  const result: NicheResearchResponse = {
    query: niche,
    queries,
    discoveryMode: !niche,
    mode,
    range,
    generatedAt: new Date().toISOString(),
    candidates: rankedCandidates,
    runs: [
      {
        niche: niche || "auto-discovery",
        status: "completed",
        candidateCount: rankedCandidates.length,
        elapsedMs: Date.now() - startedAt,
        trendNews: trendNews ?? [],
        trendSynthesis: trendSynthesis ?? emptyTrendSynthesis(),
        error: recoveryMessages.length ? recoveryMessages.join(" ") : undefined,
      },
    ],
    stats: {
      total: rankedCandidates.length,
      passed: rankedCandidates.length,
      elapsedMs: Date.now() - startedAt,
      runsCompleted: 1,
      runsTotal: 1,
    },
    usage: {
      ...usageTotals,
      model: process.env.OPENROUTER_NICHE_MODEL ?? VALIDATE_MODEL_DEFAULT,
    },
  };

  if (recoveryMessages.length) {
    try {
      const artifactPath = await saveNicheRecoveryArtifact({
        checkpointKey: resumeKey || `${niche || "auto-discovery"}-${Date.now()}`,
        checkpoint: baseCheckpoint,
        report: result,
        recoveryMessages,
      });
      const artifactMessage = `Recovery snapshot saved to ${artifactPath}`;
      recoveryMessages.push(artifactMessage);
      emit("validating", artifactMessage);
      result.runs[0].error = recoveryMessages.join(" ");
    } catch (error) {
      const artifactError = `Recovery snapshot save failed (${toRecoveryReason(error)}).`;
      recoveryMessages.push(artifactError);
      emit("validating", artifactError);
      result.runs[0].error = recoveryMessages.join(" ");
    }
  }

  await persistCheckpoint({
    resumeKey,
    checkpoint: {
      ...baseCheckpoint,
      finalReport: result,
    },
  });

  return result;
}

export async function runNicheResearchBatch(
  input: NicheBatchResearchInput,
  options: NicheResearchOptions = {},
): Promise<NicheResearchResponse> {
  const startedAt = Date.now();
  const mode = input.mode;
  const onProgress = options.onProgress;
  const abortSignal = options.abortSignal;
  const niches = [...new Set(input.niches.map((value) => value.trim()).filter(Boolean))].slice(0, 8);

  if (!niches.length) {
    return runNicheResearch({ niche: "", mode }, options);
  }

  if (niches.length === 1) {
    return runNicheResearch({ niche: niches[0], mode }, options);
  }

  const progressByNiche = new Map<string, NicheResearchProgressEvent>();
  const stateByNiche = new Map<string, "pending" | "running" | "completed" | "failed">();
  const errorByNiche = new Map<string, string>();
  const totalStepsByNiche = new Map<string, number>();
  for (const niche of niches) {
    totalStepsByNiche.set(niche, buildFocusedQueries(niche).length + 4);
    stateByNiche.set(niche, "pending");
  }

  let completedRuns = 0;

  const emitBatchProgress = (
    stage: NicheResearchProgressEvent["stage"],
    message: string,
    niche?: string,
  ) => {
    if (!onProgress) {
      return;
    }

    const completedSteps = niches.reduce((sum, key) => {
      return sum + (progressByNiche.get(key)?.completedSteps ?? 0);
    }, 0);

    const totalSteps = niches.reduce((sum, key) => sum + (progressByNiche.get(key)?.totalSteps ?? totalStepsByNiche.get(key) ?? 0), 0);

    const etaMs = niches.reduce((maxEta, key) => {
      const current = progressByNiche.get(key)?.etaMs ?? 0;
      return Math.max(maxEta, current);
    }, 0);

    const nicheStatuses: NonNullable<NicheResearchProgressEvent["nicheStatuses"]> = niches.map((key) => {
      const progress = progressByNiche.get(key);
      const state = stateByNiche.get(key) ?? "pending";
      const fallbackMessage =
        state === "pending"
          ? "Queued and waiting for worker."
          : state === "running"
            ? "Starting research steps..."
            : state === "failed"
              ? "Run failed."
              : "Run complete.";

      return {
        niche: key,
        state,
        stage: progress?.stage ?? (state === "completed" || state === "failed" ? "complete" : "starting"),
        message: progress?.message ?? fallbackMessage,
        completedSteps: progress?.completedSteps ?? 0,
        totalSteps: progress?.totalSteps ?? totalStepsByNiche.get(key) ?? 0,
        etaMs: progress?.etaMs ?? 0,
        error: errorByNiche.get(key),
      };
    });

    onProgress({
      stage,
      message,
      elapsedMs: Date.now() - startedAt,
      etaMs,
      completedSteps,
      totalSteps,
      niche,
      completedRuns,
      totalRuns: niches.length,
      nicheStatuses,
    });
  };

  emitBatchProgress("starting", `Preparing ${niches.length} niche runs in parallel...`);

  const runResults = await Promise.all(
    niches.map(async (niche) => {
      throwIfAborted(abortSignal);
      stateByNiche.set(niche, "running");
      emitBatchProgress("discovering", `Launching parallel research workers for ${niche}.`, niche);
      try {
        const report = await runNicheResearch(
          { niche, mode },
          {
            abortSignal,
            onProgress: (event) => {
              progressByNiche.set(niche, event);
              emitBatchProgress(event.stage, event.message, niche);
            },
          },
        );
        throwIfAborted(abortSignal);

        const totalSteps = totalStepsByNiche.get(niche) ?? 0;
        progressByNiche.set(niche, {
          stage: "complete",
          message: "Niche validation complete.",
          elapsedMs: report.stats.elapsedMs,
          etaMs: 0,
          completedSteps: totalSteps,
          totalSteps,
          niche,
          completedRuns,
          totalRuns: niches.length,
        });
        stateByNiche.set(niche, "completed");

        completedRuns += 1;
        emitBatchProgress("validating", `${completedRuns}/${niches.length} niche runs completed.`, niche);
        return { niche, status: "completed" as const, report };
      } catch (error) {
        if (isAbortLikeError(error) || abortSignal?.aborted) {
          throw toAbortError(error);
        }

        completedRuns += 1;
        const errorMessage = error instanceof Error ? error.message : "Unexpected niche research failure.";
        errorByNiche.set(niche, errorMessage);
        const totalSteps = totalStepsByNiche.get(niche) ?? 0;
        progressByNiche.set(niche, {
          stage: "complete",
          message: `Niche validation failed: ${errorMessage}`,
          elapsedMs: Date.now() - startedAt,
          etaMs: 0,
          completedSteps: totalSteps,
          totalSteps,
          niche,
          completedRuns,
          totalRuns: niches.length,
        });
        stateByNiche.set(niche, "failed");
        emitBatchProgress("validating", `${niche}: failed (${errorMessage})`, niche);
        return { niche, status: "failed" as const, error: errorMessage };
      }
    }),
  );
  throwIfAborted(abortSignal);

  const successful = runResults.filter((result): result is { niche: string; status: "completed"; report: NicheResearchResponse } => {
    return result.status === "completed";
  });

  const usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const flattenedCandidates = successful
    .flatMap((result) => result.report.candidates.map((candidate) => ({
      ...candidate,
      id: `${candidate.id}-${toSlug(result.niche).slice(0, 20)}`,
      requestedNiche: candidate.requestedNiche || result.niche,
    })))
    .filter((candidate) => isLaunchReadyCandidate(candidate) || isEvidenceBackedCandidate(candidate));

  const dedupedCandidates = rankCandidatesByOutcomes(dedupeCandidates(flattenedCandidates));

  for (const result of successful) {
    addUsage(usageTotals, result.report.usage);
  }

  const fallbackRange = getDateRange(30);
  const range = successful[0]?.report.range ?? fallbackRange;
  const queries = [...new Set(successful.flatMap((result) => result.report.queries))];
  const model = process.env.OPENROUTER_NICHE_MODEL ?? VALIDATE_MODEL_DEFAULT;

  emitBatchProgress("complete", `Parallel niche validation complete (${completedRuns}/${niches.length}).`);

  return {
    query: niches.join(", "),
    queries,
    discoveryMode: false,
    mode,
    range,
    generatedAt: new Date().toISOString(),
    candidates: dedupedCandidates,
    runs: runResults.map((result) => ({
      niche: result.niche,
      status: result.status,
      candidateCount: result.status === "completed" ? result.report.candidates.length : 0,
      elapsedMs: result.status === "completed" ? result.report.stats.elapsedMs : 0,
      trendNews: result.status === "completed" ? result.report.runs[0]?.trendNews ?? [] : [],
      trendSynthesis: result.status === "completed" ? result.report.runs[0]?.trendSynthesis ?? null : null,
      error: result.status === "failed" ? result.error : undefined,
    })),
    stats: {
      total: dedupedCandidates.length,
      passed: dedupedCandidates.length,
      elapsedMs: Date.now() - startedAt,
      runsCompleted: successful.length,
      runsTotal: niches.length,
    },
    usage: {
      ...usageTotals,
      model,
    },
  };
}

function buildFocusedQueries(niche: string) {
  const normalized = niche.trim();
  return [
    `${normalized} latest news updates product launches regulatory changes last 30 days`,
    `${normalized} emerging trends adoption patterns winning workflows last 30 days`,
    `${normalized} unresolved complaints failures requests for better tools last 30 days`,
  ];
}

function buildDiscoveryQueries() {
  return [
    "latest news updates product launches and regulatory changes for AI workflow automation in underserved small-business niches last 30 days",
    "emerging adoption trends and winning workflow patterns for AI operations software in service-heavy businesses last 30 days",
    "unresolved complaints failures and requests for better AI tools in operator communities and buyer forums last 30 days",
  ];
}

function describeQueryStep({
  niche,
  query,
  index,
  total,
}: {
  niche: string;
  query: string;
  index: number;
  total: number;
}) {
  const stepLabel = `Step ${index + 1}/${total}`;
  const target = niche.trim() || "auto-discovery markets";

  if (index === 0) {
    return `${stepLabel} • Scanning latest news and updates for ${target}.`;
  }
  if (index === 1) {
    return `${stepLabel} • Mapping emerging trends and adoption patterns for ${target}.`;
  }
  if (index === 2) {
    return `${stepLabel} • Collecting unresolved complaints and unmet requests for ${target}.`;
  }

  return `${stepLabel} • Running trend query for ${target}: ${query}`;
}

async function runThreeSourceSearch({
  query,
  mode,
  fromDate,
  toDate,
  signal,
}: {
  query: string;
  mode: NicheResearchDepth;
  fromDate: string;
  toDate: string;
  signal?: AbortSignal;
}) {
  const [redditResult, xResult, webResult] = await Promise.allSettled([
    searchReddit({ topic: query, depth: mode, fromDate, toDate, signal }),
    searchX({ topic: query, depth: mode, fromDate, toDate, signal }),
    searchWeb({ topic: query, depth: mode, fromDate, toDate, signal }),
  ]);

  if (signal?.aborted) {
    throw toAbortError();
  }

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const items = {
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

async function synthesizeTrendEvidence({
  niche,
  range,
  evidenceIndex,
  signal,
}: {
  niche: string;
  range: { from: string; to: string };
  evidenceIndex: EvidenceIndex;
  signal?: AbortSignal;
}) {
  const model = process.env.OPENROUTER_SYNTH_MODEL ?? TREND_SYNTH_MODEL_DEFAULT;

  const prompt = `You are synthesizing the latest 30-day evidence for an AI product opportunity explorer.

Niche context: ${niche}
Date window: ${range.from} to ${range.to}

Reddit evidence:
${compactEvidenceByType(evidenceIndex, "reddit")}

X evidence:
${compactEvidenceByType(evidenceIndex, "x")}

Web evidence:
${compactEvidenceByType(evidenceIndex, "web")}

Return strict JSON:
{
  "summary": "string",
  "keyTrends": ["string"],
  "unresolvedIssues": ["string"],
  "opportunityGaps": ["string"],
  "citations": [
    {
      "claim": "string",
      "sourceUrl": "https://...",
      "date": "YYYY-MM-DD or null",
      "sourceType": "reddit|x|web"
    }
  ]
}

Rules:
- Use only source URLs present in provided evidence.
- Keep citations to max 12.
- Output JSON only.`;

  const response = await openRouterRequest<ChatCompletionResponse>({
    path: "/chat/completions",
    payload: {
      model,
      messages: [
        {
          role: "system",
          content: "You are a rigorous research synthesis analyst. Use only provided evidence. Return strict JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
      max_tokens: 1800,
      response_format: { type: "json_object" },
    },
    timeoutMs: 90000,
    signal,
  });

  const raw = response.choices?.[0]?.message?.content ?? "";
  const parsed = extractJsonObject<RawTrendSynthesis>(raw);

  const synthesis: NicheTrendSynthesis = {
    summary: toSafeString(parsed?.summary, "No synthesis summary generated."),
    keyTrends: toStringArray(parsed?.keyTrends, 8),
    unresolvedIssues: toStringArray(parsed?.unresolvedIssues, 8),
    opportunityGaps: toStringArray(parsed?.opportunityGaps, 8),
    citations: normalizeProofPoints(parsed?.citations, evidenceIndex),
  };

  return {
    synthesis,
    usage: {
      ...extractUsage(response as unknown as Record<string, unknown>),
      calls: 1,
      model,
    },
  };
}

function emptyTrendSynthesis(): NicheTrendSynthesis {
  return {
    summary: "Trend synthesis unavailable.",
    keyTrends: [],
    unresolvedIssues: [],
    opportunityGaps: [],
    citations: [],
  };
}

function isWeakTrendSynthesis(value: NicheTrendSynthesis) {
  const summary = value.summary.trim().toLowerCase();
  const placeholder =
    !summary ||
    summary === "no synthesis summary generated." ||
    summary === "trend synthesis unavailable.";

  return placeholder || value.citations.length < 3 || (!value.keyTrends.length && !value.unresolvedIssues.length);
}

function buildHeuristicTrendSynthesis({
  niche,
  evidenceIndex,
  range,
}: {
  niche: string;
  evidenceIndex: EvidenceIndex;
  range: { from: string; to: string };
}): NicheTrendSynthesis {
  const refs = evidenceIndex.refs.slice(0, 18);
  if (!refs.length) {
    return emptyTrendSynthesis();
  }

  const keyTrends = extractThemesFromHeadlines(refs.map((item) => item.headline), 5);
  const unresolvedIssues = extractIssueSignals(refs).slice(0, 5);
  const opportunityGaps = unresolvedIssues.map((issue) => `AI workflow opportunity: ${issue}`).slice(0, 5);
  const citations = refs.slice(0, 8).map((item) => ({
    claim: item.headline,
    sourceUrl: item.url,
    date: item.date,
    sourceType: item.sourceType,
  }));

  const sourceBreakdown = [
    `Reddit ${refs.filter((item) => item.sourceType === "reddit").length}`,
    `X ${refs.filter((item) => item.sourceType === "x").length}`,
    `Web ${refs.filter((item) => item.sourceType === "web").length}`,
  ].join(", ");

  return {
    summary: `Heuristic synthesis for ${niche}: ${refs.length} evidence signals (${sourceBreakdown}) in ${range.from} to ${range.to} indicate demand around ${keyTrends.join(", ") || "workflow automation pain points"}.`,
    keyTrends: keyTrends.length ? keyTrends : ["Growing requests for better workflow tooling"],
    unresolvedIssues: unresolvedIssues.length ? unresolvedIssues : ["Manual workflows remain error-prone and slow."],
    opportunityGaps: opportunityGaps.length ? opportunityGaps : ["AI copilots for high-friction operational tasks"],
    citations,
  };
}

async function generateValidatedCandidates({
  niche,
  mode,
  range,
  candidateCount,
  reddit,
  x,
  web,
  trendSynthesis,
  retryMode = false,
  signal,
}: {
  niche: string;
  mode: NicheResearchDepth;
  range: { from: string; to: string };
  candidateCount: number;
  reddit: RedditItem[];
  x: XItem[];
  web: WebItem[];
  trendSynthesis: NicheTrendSynthesis;
  retryMode?: boolean;
  signal?: AbortSignal;
}) {
  const model = process.env.OPENROUTER_NICHE_MODEL ?? VALIDATE_MODEL_DEFAULT;
  const maxTokens = retryMode ? MODE_CONFIG[mode].validateMaxTokens + 1200 : MODE_CONFIG[mode].validateMaxTokens;
  const prompt = buildValidationPrompt({
    niche,
    range,
    candidateCount,
    reddit,
    x,
    web,
    trendSynthesis,
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
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    },
    timeoutMs: 120000,
    signal,
  });

  const raw = response.choices?.[0]?.message?.content ?? "";
  const parsed = extractJsonObject<RawCandidatesOutput>(raw);
  const looseItems = extractLooseCandidates(raw);

  return {
    items: Array.isArray(parsed?.candidates) ? parsed.candidates : looseItems,
    usage: {
      ...extractUsage(response as unknown as Record<string, unknown>),
      calls: 1,
    },
  };
}

function extractLooseCandidates(raw: string): RawNicheCandidate[] {
  const text = raw.trim();
  if (!text) {
    return [];
  }

  const candidatesArrayIndex = text.indexOf('"candidates"');
  if (candidatesArrayIndex !== -1) {
    const bracketStart = text.indexOf("[", candidatesArrayIndex);
    const bracketEnd = text.lastIndexOf("]");
    if (bracketStart !== -1 && bracketEnd > bracketStart) {
      const slice = text.slice(bracketStart, bracketEnd + 1);
      try {
        const parsed = JSON.parse(slice) as unknown;
        if (Array.isArray(parsed)) {
          return parsed as RawNicheCandidate[];
        }
      } catch {
        // Continue to fallback parsing below.
      }
    }
  }

  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstArray !== -1 && lastArray > firstArray) {
    try {
      const parsed = JSON.parse(text.slice(firstArray, lastArray + 1)) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as RawNicheCandidate[];
      }
    } catch {
      return [];
    }
  }

  return [];
}

function buildValidationPrompt({
  niche,
  range,
  candidateCount,
  reddit,
  x,
  web,
  trendSynthesis,
  retryMode,
}: {
  niche: string;
  range: { from: string; to: string };
  candidateCount: number;
  reddit: RedditItem[];
  x: XItem[];
  web: WebItem[];
  trendSynthesis: NicheTrendSynthesis;
  retryMode: boolean;
}) {
  const scope = niche
    ? `User niche focus: ${niche}. Propose validated sub-niches or specific slices within this market.`
    : "No niche provided. Discover validated niches from the evidence.";

  return `Date window is fixed: ${range.from} to ${range.to} (inclusive). Use only the evidence below.
${scope}

Trend synthesis:
- Summary: ${trendSynthesis.summary}
- Key trends: ${trendSynthesis.keyTrends.join(" | ") || "none"}
- Unresolved issues: ${trendSynthesis.unresolvedIssues.join(" | ") || "none"}
- Opportunity gaps: ${trendSynthesis.opportunityGaps.join(" | ") || "none"}
- Synthesis citations:
${trendSynthesis.citations.map((item) => `  - ${item.sourceType} ${item.claim} (${item.sourceUrl})`).join("\n") || "  - none"}

Goal:
- Return up to ${candidateCount} evidence-backed AI product ideas.
- Every idea must include 3-5 proofPoints with sourceUrl values found in the evidence below.
- Every idea must map unresolved issue -> proposed AI solution explicitly.
- Fill all check fields and set passed booleans conservatively based on evidence.

Checks:
1) Spending: evidence that buyers spend >= $500/year on this problem via consultants, courses, or tools.
2) Pain: recurring complaint appears 3+ times.
3) Room: active launch community with under 50k members and real engagement.

${retryMode ? "Retry mode: infer conservative but concrete estimates from provided evidence when exact values are missing." : "Use strict evidence extraction from provided items."}

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
      "name": "short specific product name",
      "problemStatement": "specific unresolved pain",
      "oneLiner": "solution in one line",
      "aiBuildAngle": "how AI solves this better",
      "icp": "ideal customer",
      "audience": "target audience",
      "whyNow": "why this is urgent now",
      "recommendation": "launch recommendation",
      "score": 0,
      "verdict": "pass|watch|fail",
      "proofPoints": [
        { "claim": "string", "sourceUrl": "https://...", "date": "YYYY-MM-DD or null", "sourceType": "reddit|x|web" }
      ],
      "validationPlan": [{ "experiment": "string", "successMetric": "string", "effort": "low|medium|high" }],
      "risks": ["string"],
      "checks": {
        "spending": {
          "passed": true,
          "estimatedAnnualSpendUsd": 0,
          "thresholdUsd": 500,
          "evidence": ["string"],
          "claims": [{ "claim": "string", "confidence": "high|med|low", "sourceUrl": "https://..." }],
          "offerings": [{ "title": "string", "priceText": "string", "annualPriceUsd": 0, "url": "https://..." }]
        },
        "pain": {
          "passed": true,
          "recurringComplaintCount": 0,
          "complaintThemes": ["string"],
          "evidence": ["string"],
          "claims": [{ "claim": "string", "confidence": "high|med|low", "sourceUrl": "https://..." }]
        },
        "room": {
          "passed": true,
          "communityName": "string",
          "platform": "Reddit|Discord|Facebook|Slack|Forum|X",
          "members": 0,
          "engagementSignal": "string",
          "evidence": ["string"],
          "claims": [{ "claim": "string", "confidence": "high|med|low", "sourceUrl": "https://..." }],
          "url": "https://..."
        }
      },
      "sources": [
        { "title": "string", "url": "https://...", "note": "string", "type": "spending|pain|room|general", "date": "YYYY-MM-DD" }
      ]
    }
  ]
}

Rules:
- JSON only.
- Use only URLs present in evidence above.
- proofPoints length must be >= 3.
- source.date must be between ${range.from} and ${range.to} when date exists.
- confidence must be one of: high, med, low.
- Prefer strongest opportunities first and keep checks evidence-aligned.`;
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

function normalizeCandidate(
  raw: RawNicheCandidate,
  index: number,
  requestedNiche: string | null,
  evidenceIndex: EvidenceIndex,
): NicheCandidate {
  const name = toSafeString(raw.name, `Niche ${index + 1}`);

  const thresholdUsd = Math.max(500, toNullableNumber(raw.checks?.spending?.thresholdUsd) ?? 500);
  const spendingEstimate = toNullableNumber(raw.checks?.spending?.estimatedAnnualSpendUsd);
  const spendingEvidence = toStringArray(raw.checks?.spending?.evidence, 8);
  const spendingClaims = normalizeEvidenceClaims(raw.checks?.spending?.claims, raw.checks?.spending?.evidence, "spending");
  const offerings = normalizeOfferings(raw.checks?.spending?.offerings);
  const hasPriceSignal =
    (spendingEstimate !== null && spendingEstimate >= thresholdUsd) ||
    offerings.some((offering) => (offering.annualPriceUsd ?? 0) >= thresholdUsd);
  const spendingRawPassed = toBoolean(raw.checks?.spending?.passed);
  const spendingPassed =
    spendingRawPassed ||
    (hasPriceSignal && (spendingEvidence.length > 0 || spendingClaims.length > 0 || offerings.length > 0));

  const painEvidence = toStringArray(raw.checks?.pain?.evidence, 8);
  const painClaims = normalizeEvidenceClaims(raw.checks?.pain?.claims, raw.checks?.pain?.evidence, "pain");
  const recurringComplaintCount = Math.max(
    toNullableNumber(raw.checks?.pain?.recurringComplaintCount) ?? 0,
    painEvidence.length,
    painClaims.length,
  );
  const complaintThemes = toStringArray(raw.checks?.pain?.complaintThemes, 8);
  const painRawPassed = toBoolean(raw.checks?.pain?.passed);
  const painPassed =
    painRawPassed ||
    (recurringComplaintCount >= 3 && (painEvidence.length > 0 || painClaims.length > 0 || complaintThemes.length > 0));

  const roomEvidence = toStringArray(raw.checks?.room?.evidence, 8);
  const roomClaims = normalizeEvidenceClaims(raw.checks?.room?.claims, raw.checks?.room?.evidence, "room");
  const communityMembers = toNullableNumber(raw.checks?.room?.members);
  const roomUrlRaw = toSafeString(raw.checks?.room?.url, "");
  const roomUrlMatch = resolveEvidenceReference(roomUrlRaw, evidenceIndex);
  const roomUrl = roomUrlMatch?.url ?? (hasValidUrl(roomUrlRaw) ? roomUrlRaw : "");
  const engagementSignal = toSafeString(raw.checks?.room?.engagementSignal, "");
  const inferredEngagementSignal = engagementSignal || roomEvidence[0] || roomClaims[0]?.claim || "";
  const roomRawPassed = toBoolean(raw.checks?.room?.passed);
  const hasCommunitySignal = roomEvidence.length > 0 || roomClaims.length > 0 || hasValidUrl(roomUrl);
  const memberBoundsOk = communityMembers === null || (communityMembers > 0 && communityMembers < 50000);
  const roomPassed =
    roomRawPassed ||
    (hasCommunitySignal && memberBoundsOk && Boolean(inferredEngagementSignal));

  const passCount = [spendingPassed, painPassed, roomPassed].filter(Boolean).length;
  const sources = normalizeSources(raw.sources, evidenceIndex);
  const proofPoints = hydrateProofPoints({
    baseProofPoints: normalizeProofPoints(raw.proofPoints, evidenceIndex),
    sources,
    claims: [...spendingClaims, ...painClaims, ...roomClaims],
    evidenceIndex,
  });

  return {
    id: createCandidateId(name, index),
    name,
    requestedNiche: requestedNiche || undefined,
    problemStatement: toSafeString(raw.problemStatement, "Painful workflow with recurring manual effort and spend."),
    oneLiner: toSafeString(raw.oneLiner, ""),
    aiBuildAngle: toSafeString(raw.aiBuildAngle, ""),
    icp: toSafeString(raw.icp, toSafeString(raw.audience, "Operators with recurring workflow pain")),
    audience: toSafeString(raw.audience, ""),
    whyNow: toSafeString(raw.whyNow, ""),
    recommendation: toSafeString(raw.recommendation, ""),
    score: clampScore(raw.score),
    verdict: normalizeVerdict(raw.verdict, passCount),
    proofPoints,
    demand: {
      trendSummary: toSafeString(raw.demand?.trendSummary, "Demand signal exists but requires targeted validation."),
      urgencyDrivers: toStringArray(raw.demand?.urgencyDrivers, 6),
      buyingSignals: toStringArray(raw.demand?.buyingSignals, 6),
      searchKeywords: toStringArray(raw.demand?.searchKeywords, 10),
    },
    landscape: {
      competitionLevel: normalizeCompetitionLevel(raw.landscape?.competitionLevel),
      incumbentTypes: toStringArray(raw.landscape?.incumbentTypes, 8),
      whitespace: toStringArray(raw.landscape?.whitespace, 8),
      beachheadWedge: toSafeString(raw.landscape?.beachheadWedge, "Faster onboarding and workflow automation."),
    },
    businessModel: {
      pricingModel: toSafeString(raw.businessModel?.pricingModel, "SaaS subscription"),
      priceAnchor: toSafeString(raw.businessModel?.priceAnchor, "$49-$299 per month"),
      timeToFirstDollar: toSafeString(raw.businessModel?.timeToFirstDollar, "2-6 weeks via pilot offers"),
      expectedGrossMargin: toSafeString(raw.businessModel?.expectedGrossMargin, "70%+ with software-led delivery"),
    },
    goToMarket: {
      channels: toStringArray(raw.goToMarket?.channels, 8),
      offerHook: toSafeString(raw.goToMarket?.offerHook, "Automate painful recurring work in under 7 days."),
      salesMotion: toSafeString(raw.goToMarket?.salesMotion, "Founder-led outbound + warm community conversations"),
      retentionLoop: toSafeString(raw.goToMarket?.retentionLoop, "Weekly ROI reporting tied to hours saved"),
    },
    execution: {
      buildComplexity: normalizeComplexity(raw.execution?.buildComplexity),
      stackRecommendation: toSafeString(raw.execution?.stackRecommendation, "Next.js + workflow automation + LLM APIs"),
      mvpScope: toStringArray(raw.execution?.mvpScope, 8),
      automationLevers: toStringArray(raw.execution?.automationLevers, 8),
      moatLevers: toStringArray(raw.execution?.moatLevers, 8),
    },
    outcomes: normalizeOutcomes(raw.outcomes),
    competitors: [],
    personaVariants: normalizePersonaVariants(raw.personaVariants),
    validationPlan: normalizeValidationPlan(raw.validationPlan),
    risks: toStringArray(raw.risks, 8),
    killCriteria: toStringArray(raw.killCriteria, 8),
    checks: {
      spending: {
        passed: spendingPassed,
        estimatedAnnualSpendUsd: spendingEstimate,
        thresholdUsd,
        evidence: spendingEvidence,
        claims: spendingClaims,
        offerings,
      },
      pain: {
        passed: painPassed,
        recurringComplaintCount,
        complaintThemes,
        evidence: painEvidence,
        claims: painClaims,
      },
      room: {
        passed: roomPassed,
        communityName: toSafeString(raw.checks?.room?.communityName, "Unknown community"),
        platform: toSafeString(raw.checks?.room?.platform, "Community"),
        members: communityMembers,
        engagementSignal: inferredEngagementSignal || "No engagement signal provided.",
        evidence: roomEvidence,
        claims: roomClaims,
        url: roomUrl,
      },
    },
    sources,
  };
}

function normalizeProofPoints(value: unknown, evidenceIndex: EvidenceIndex) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const typed = item as RawProofPoint;
      const inputSourceUrl = toSafeString(typed.sourceUrl, "");
      const match = resolveEvidenceReference(inputSourceUrl, evidenceIndex);
      if (!match) {
        return null;
      }

      const sourceType = typed.sourceType === "reddit" || typed.sourceType === "x" || typed.sourceType === "web"
        ? typed.sourceType
        : match.sourceType;

      const claim = toSafeString(typed.claim, "");
      if (!claim) {
        return null;
      }

      const key = `${claim.toLowerCase()}|${match.url}`;
      if (seen.has(key)) {
        return null;
      }
      seen.add(key);

      return {
        claim,
        sourceUrl: match.url,
        date: toNullableDateString(typed.date) ?? match.date,
        sourceType,
      } satisfies NicheProofPoint;
    })
    .filter((item): item is NicheProofPoint => Boolean(item))
    .slice(0, 12);
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

function normalizeSources(value: unknown, evidenceIndex: EvidenceIndex): NicheSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();

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

      const rawUrl = toSafeString(typed.url, "");
      const match = resolveEvidenceReference(rawUrl, evidenceIndex);
      if (!match) {
        return null;
      }
      const url = match.url;

      const sourceType: NicheSource["type"] =
        typed.type === "spending" || typed.type === "pain" || typed.type === "room" || typed.type === "general"
          ? typed.type
          : "general";

      if (seen.has(url)) {
        return null;
      }
      seen.add(url);

      return {
        title: toSafeString(typed.title, "Source"),
        url,
        note: toSafeString(typed.note, ""),
        type: sourceType,
        date: toNullableDateString(typed.date) ?? match.date,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 18);
}

function hydrateProofPoints({
  baseProofPoints,
  sources,
  claims,
  evidenceIndex,
}: {
  baseProofPoints: NicheProofPoint[];
  sources: NicheSource[];
  claims: Array<{ claim: string; sourceUrl?: string }>;
  evidenceIndex: EvidenceIndex;
}) {
  const output: NicheProofPoint[] = [];
  const seen = new Set<string>();

  const push = (item: NicheProofPoint | null) => {
    if (!item) {
      return;
    }
    const key = `${item.claim.toLowerCase()}|${item.sourceUrl}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push(item);
  };

  for (const item of baseProofPoints) {
    push(item);
  }

  for (const claim of claims) {
    if (!claim.claim || !claim.sourceUrl) {
      continue;
    }
    const match = resolveEvidenceReference(claim.sourceUrl, evidenceIndex);
    if (!match) {
      continue;
    }
    push({
      claim: claim.claim,
      sourceUrl: match.url,
      date: match.date,
      sourceType: match.sourceType,
    });
  }

  for (const source of sources) {
    const match = resolveEvidenceReference(source.url, evidenceIndex);
    if (!match) {
      continue;
    }
    push({
      claim: source.note || source.title,
      sourceUrl: match.url,
      date: source.date ?? match.date,
      sourceType: match.sourceType,
    });
  }

  for (const ref of evidenceIndex.refs) {
    if (output.length >= 3) {
      break;
    }
    push({
      claim: ref.headline,
      sourceUrl: ref.url,
      date: ref.date,
      sourceType: ref.sourceType,
    });
  }

  return output.slice(0, 12);
}

function normalizeEvidenceClaims(
  value: unknown,
  fallbackEvidence: unknown,
  dimension: "spending" | "pain" | "room",
): NicheCandidate["checks"][typeof dimension]["claims"] {
  if (Array.isArray(value)) {
    const claims = value
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const typed = item as {
          claim?: unknown;
          confidence?: unknown;
          sourceUrl?: unknown;
        };

        const claim = toSafeString(typed.claim, "");
        if (!claim) {
          return null;
        }

        const sourceUrl = toSafeString(typed.sourceUrl, "");
        return {
          claim,
          confidence: normalizeEvidenceConfidence(typed.confidence),
          sourceUrl: hasValidUrl(sourceUrl) ? sourceUrl : undefined,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, 10);

    if (claims.length) {
      return claims;
    }
  }

  const fallback = toStringArray(fallbackEvidence, 8);
  const defaultConfidence: NicheCandidate["checks"][typeof dimension]["claims"][number]["confidence"] =
    dimension === "spending" ? "high" : "med";

  return fallback.map((claim) => ({
    claim,
    confidence: inferClaimConfidence(claim, defaultConfidence),
  }));
}

function normalizeEvidenceConfidence(value: unknown): "high" | "med" | "low" {
  if (value === "high" || value === "med" || value === "low") {
    return value;
  }
  return "med";
}

function inferClaimConfidence(claim: string, fallback: "high" | "med" | "low"): "high" | "med" | "low" {
  const text = claim.toLowerCase();
  if (/\$|\d+%|\d{1,3}k|\d{1,3}m|\bsource\b|\bverified\b/.test(text)) {
    return "high";
  }
  if (/\bmaybe\b|\bseems\b|\blikely\b|\bpossible\b/.test(text)) {
    return "low";
  }
  return fallback;
}

function normalizePersonaVariants(value: unknown): NicheCandidate["personaVariants"] {
  const normalized = Array.isArray(value)
    ? value
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }

          const typed = item as {
            persona?: unknown;
            primaryPain?: unknown;
            offerVariant?: unknown;
            pricingAngle?: unknown;
            bestChannel?: unknown;
          };

          const persona = normalizePersonaType(typed.persona);
          if (!persona) {
            return null;
          }

          return {
            persona,
            primaryPain: toSafeString(typed.primaryPain, ""),
            offerVariant: toSafeString(typed.offerVariant, ""),
            pricingAngle: toSafeString(typed.pricingAngle, ""),
            bestChannel: toSafeString(typed.bestChannel, ""),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .slice(0, 6)
    : [];

  const byPersona = new Map<string, NicheCandidate["personaVariants"][number]>();
  for (const entry of normalized) {
    byPersona.set(entry.persona, entry);
  }

  for (const persona of ["agency-owner", "operator", "founder"] as const) {
    if (!byPersona.has(persona)) {
      byPersona.set(persona, {
        persona,
        primaryPain: "Manual workflows are too slow and expensive.",
        offerVariant: "AI-assisted workflow automation",
        pricingAngle: "ROI-based monthly subscription",
        bestChannel: "Direct outreach + community channels",
      });
    }
  }

  return [...byPersona.values()];
}

function normalizePersonaType(value: unknown): NicheCandidate["personaVariants"][number]["persona"] | null {
  if (value === "agency-owner" || value === "operator" || value === "founder") {
    return value;
  }
  return null;
}

function normalizeOutcomes(value: unknown): NicheCandidate["outcomes"] {
  const typed = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const timeToFirstDollarDays = clampInteger(typed.timeToFirstDollarDays, 14, 365, 60);
  const gtmDifficulty = clampInteger(typed.gtmDifficulty, 1, 10, 5);
  const integrationComplexity = clampInteger(typed.integrationComplexity, 1, 10, 5);

  return {
    timeToFirstDollarDays,
    gtmDifficulty,
    integrationComplexity,
    weightedScore: computeOutcomeScore({ timeToFirstDollarDays, gtmDifficulty, integrationComplexity }),
  };
}

function normalizeValidationPlan(value: unknown): NicheCandidate["validationPlan"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const typed = item as {
        experiment?: unknown;
        successMetric?: unknown;
        effort?: unknown;
      };

      return {
        experiment: toSafeString(typed.experiment, ""),
        successMetric: toSafeString(typed.successMetric, ""),
        effort: normalizeEffort(typed.effort),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item && item.experiment && item.successMetric))
    .slice(0, 6);
}

function normalizeCompetitionLevel(value: unknown): NicheCandidate["landscape"]["competitionLevel"] {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function normalizeComplexity(value: unknown): NicheCandidate["execution"]["buildComplexity"] {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function normalizeEffort(value: unknown): NicheCandidate["validationPlan"][number]["effort"] {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function isLaunchReadyCandidate(candidate: NicheCandidate) {
  return (
    candidate.checks.spending.passed &&
    candidate.checks.pain.passed &&
    candidate.checks.room.passed &&
    candidate.proofPoints.length >= 3
  );
}

function isEvidenceBackedCandidate(candidate: NicheCandidate) {
  return candidate.proofPoints.length >= 3 && countPassedChecks(candidate) >= 2;
}

function countPassedChecks(candidate: NicheCandidate) {
  return [candidate.checks.spending.passed, candidate.checks.pain.passed, candidate.checks.room.passed].filter(Boolean).length;
}

function dedupeCandidates(candidates: NicheCandidate[]) {
  const seen = new Set<string>();
  const result: NicheCandidate[] = [];

  for (const candidate of candidates) {
    const keys = [
      `${candidate.requestedNiche ?? "global"}|${candidate.name.toLowerCase().trim()}`,
      candidateSimilarityKey(candidate),
    ];

    if (keys.some((key) => seen.has(key))) {
      continue;
    }

    for (const key of keys) {
      seen.add(key);
    }
    result.push(candidate);
  }

  return result;
}

function candidateSimilarityKey(candidate: NicheCandidate) {
  const normalizedProblem = candidate.problemStatement.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const proofUrls = candidate.proofPoints
    .map((item) => canonicalizeUrl(item.sourceUrl) ?? item.sourceUrl)
    .sort()
    .slice(0, 3)
    .join("|");

  return `${candidate.requestedNiche ?? "global"}|${normalizedProblem.slice(0, 160)}|${proofUrls}`;
}

async function enrichCandidates({
  candidates,
  range,
  mode,
  signal,
}: {
  candidates: NicheCandidate[];
  range: { from: string; to: string };
  mode: NicheResearchDepth;
  signal?: AbortSignal;
}) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const concurrencyLimit = mode === "deep" ? 8 : mode === "default" ? 6 : 4;
  const queue = [...candidates];
  const enriched: NicheCandidate[] = [];

  async function worker() {
    while (queue.length) {
      throwIfAborted(signal);
      const candidate = queue.shift();
      if (!candidate) {
        return;
      }

      try {
        const result = await scrapeCompetitors(candidate, range, mode, signal);
        throwIfAborted(signal);
        addUsage(usage, result.usage);
        enriched.push({
          ...candidate,
          competitors: result.competitors,
        });
      } catch (error) {
        if (isAbortLikeError(error) || signal?.aborted) {
          throw toAbortError(error);
        }
        enriched.push(candidate);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrencyLimit, Math.max(1, candidates.length)) }, () => worker()));
  return { items: enriched, usage };
}

async function scrapeCompetitors(
  candidate: NicheCandidate,
  range: { from: string; to: string },
  mode: NicheResearchDepth,
  signal?: AbortSignal,
) {
  const model = process.env.OPENROUTER_WEB_MODEL ?? COMPETITOR_MODEL_DEFAULT;
  const maxCompetitors = mode === "quick" ? 2 : mode === "default" ? 4 : 5;
  const prompt = `Research direct competitors for this niche and return structured JSON.

Niche idea: ${candidate.name}
Audience: ${candidate.audience}
Problem: ${candidate.problemStatement}
Date window preference: ${range.from} to ${range.to}

For each competitor include:
- name
- url
- pricingSummary (actual tiers/range if available)
- onboardingFriction (where setup/integration is hard)
- reviewSentiment (common positive/negative patterns)
- confidence (high|med|low)

Return strict JSON:
{
  "competitors": [
    {
      "name": "string",
      "url": "https://...",
      "pricingSummary": "string",
      "onboardingFriction": "string",
      "reviewSentiment": "string",
      "confidence": "high|med|low"
    }
  ]
}

Rules:
- Max ${maxCompetitors} competitors
- Use reputable sources and public pricing pages when possible
- JSON only`;

  const response = await openRouterRequest<OpenRouterResponsesResponse>({
    path: "/responses",
    payload: {
      model,
      tools: [{ type: "web_search" }],
      input: [{ role: "user", content: prompt }],
    },
    timeoutMs: getCompetitorTimeout(mode),
    signal,
  });

  const text = extractTextFromOpenRouterResponse(response as unknown as Record<string, unknown>);
  const parsed = extractJsonObject<RawCompetitorOutput>(text);
  const competitors = normalizeCompetitors(parsed?.competitors, maxCompetitors);

  return {
    competitors,
    usage: {
      ...extractUsage(response as unknown as Record<string, unknown>),
      calls: 1,
    },
  };
}

function compactEvidenceByType(evidenceIndex: EvidenceIndex, sourceType: EvidenceReference["sourceType"]) {
  const lines = evidenceIndex.refs
    .filter((item) => item.sourceType === sourceType)
    .slice(0, 24)
    .map((item) => `- [${item.date ?? "unknown"}] ${item.headline} (${item.url})`);

  if (!lines.length) {
    return "- none";
  }

  return lines.join("\n");
}

function createEvidenceIndex({
  reddit,
  x,
  web,
}: {
  reddit: RedditItem[];
  x: XItem[];
  web: WebItem[];
}): EvidenceIndex {
  const refs: EvidenceReference[] = [];
  const byMatchKey = new Map<string, EvidenceReference>();

  const pushRef = (ref: EvidenceReference) => {
    refs.push(ref);
    for (const key of buildUrlMatchKeys(ref.url)) {
      if (!byMatchKey.has(key)) {
        byMatchKey.set(key, ref);
      }
    }
  };

  for (const item of reddit) {
    if (!hasValidUrl(item.url)) {
      continue;
    }
    pushRef({
      sourceType: "reddit",
      url: item.url,
      date: toNullableDateString(item.date),
      headline: toSafeString(item.title, "Reddit trend signal"),
    });
  }

  for (const item of x) {
    if (!hasValidUrl(item.url)) {
      continue;
    }
    pushRef({
      sourceType: "x",
      url: item.url,
      date: toNullableDateString(item.date),
      headline: toSafeString(item.text, "X trend signal"),
    });
  }

  for (const item of web) {
    if (!hasValidUrl(item.url)) {
      continue;
    }
    pushRef({
      sourceType: "web",
      url: item.url,
      date: toNullableDateString(item.date),
      headline: toSafeString(item.title, "Web trend signal"),
    });
  }

  return {
    refs,
    byMatchKey,
  };
}

function resolveEvidenceReference(url: string, evidenceIndex: EvidenceIndex) {
  if (!hasValidUrl(url)) {
    return null;
  }

  for (const key of buildUrlMatchKeys(url)) {
    const match = evidenceIndex.byMatchKey.get(key);
    if (match) {
      return match;
    }
  }

  return null;
}

function buildUrlMatchKeys(url: string) {
  const canonical = canonicalizeUrl(url);
  if (!canonical) {
    return [];
  }

  const withoutQuery = canonical.split("?")[0] ?? canonical;
  return withoutQuery === canonical ? [canonical] : [canonical, withoutQuery];
}

function canonicalizeUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    const pathname = parsed.pathname.replace(/\/+$/g, "") || "/";
    parsed.hash = "";

    const removableParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "ref_src",
      "fbclid",
      "gclid",
      "igshid",
    ];

    for (const param of removableParams) {
      parsed.searchParams.delete(param);
    }

    parsed.searchParams.sort();
    const query = parsed.searchParams.toString();
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${pathname}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

function buildTrendNewsFromEvidence({
  trendSynthesis,
  evidenceIndex,
}: {
  trendSynthesis: NicheTrendSynthesis;
  evidenceIndex: EvidenceIndex;
}) {
  const output: NicheTrendNews[] = [];
  const seen = new Set<string>();

  const push = (item: NicheTrendNews | null) => {
    if (!item || seen.has(item.url)) {
      return;
    }
    seen.add(item.url);
    output.push(item);
  };

  for (const citation of trendSynthesis.citations) {
    const match = resolveEvidenceReference(citation.sourceUrl, evidenceIndex);
    if (!match) {
      continue;
    }

    push({
      title: match.headline.slice(0, 220),
      url: match.url,
      summary: citation.claim.slice(0, 420),
      whyItMatters: toSafeString(trendSynthesis.summary, "Recent 30-day evidence indicates a material market signal.").slice(0, 260),
      date: citation.date ?? match.date,
      confidence: "med",
    });
  }

  for (const ref of evidenceIndex.refs) {
    if (output.length >= 6) {
      break;
    }
    push({
      title: ref.headline.slice(0, 220),
      url: ref.url,
      summary: ref.headline.slice(0, 420),
      whyItMatters: "Signal captured during the latest 30-day trend scan.",
      date: ref.date,
      confidence: "med",
    });
  }

  return output.slice(0, 6);
}

function buildFallbackCandidatesFromEvidence({
  niche,
  requestedNiche,
  trendSynthesis,
  evidenceIndex,
  candidateCount,
}: {
  niche: string;
  requestedNiche: string | null;
  trendSynthesis: NicheTrendSynthesis;
  evidenceIndex: EvidenceIndex;
  candidateCount: number;
}) {
  if (evidenceIndex.refs.length < 3) {
    return [];
  }

  const refs = evidenceIndex.refs;
  const issues = uniqueStrings(
    (trendSynthesis.unresolvedIssues.length ? trendSynthesis.unresolvedIssues : extractIssueSignals(refs))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const gaps = uniqueStrings(
    (trendSynthesis.opportunityGaps.length ? trendSynthesis.opportunityGaps : trendSynthesis.keyTrends)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const topic = niche.trim() || "operations";

  const maxCandidates = Math.max(1, Math.min(candidateCount, Math.max(1, Math.min(3, issues.length))));
  const usedProofSignatures = new Set<string>();
  const results: NicheCandidate[] = [];

  for (let index = 0; index < maxCandidates; index += 1) {
    const issue = issues[index] ?? issues[0] ?? "Recurring manual bottlenecks";
    const gap = gaps[index] ?? gaps[0] ?? "AI automation for high-friction tasks";
    const proofPoints = selectProofPointsForIssue({
      issue,
      refs,
      offset: index,
    });

    if (proofPoints.length < 3) {
      continue;
    }

    const proofSignature = proofPoints.map((item) => item.sourceUrl).sort().join("|");
    if (usedProofSignatures.has(proofSignature)) {
      continue;
    }
    usedProofSignatures.add(proofSignature);

    const spendingClaims = proofPoints.filter((item) => isSpendingSignal(item.claim));
    const painClaims = proofPoints.filter((item) => isPainSignal(item.claim));
    const roomClaims = proofPoints.filter((item) => isRoomSignal(item.claim));

    const spendingEvidence = (spendingClaims.length ? spendingClaims : proofPoints.slice(0, 2)).map((item) => item.claim);
    const painEvidence = (painClaims.length ? painClaims : proofPoints.slice(1, 3)).map((item) => item.claim);
    const roomEvidence = (roomClaims.length ? roomClaims : [proofPoints[0], proofPoints[2]].filter(Boolean)).map((item) => item.claim);

    const spendingPassed = spendingEvidence.length > 0;
    const painPassed = Math.max(3, painEvidence.length) >= 3;
    const roomPassed = roomEvidence.length > 0;
    const passCount = [spendingPassed, painPassed, roomPassed].filter(Boolean).length;
    const verdict = normalizeVerdict(undefined, passCount);
    const baseScore = passCount === 3 ? 72 : passCount === 2 ? 64 : 55;

    const candidateName = toTitleCase(buildFallbackNameFromIssue(issue, topic));
    const fallback: NicheCandidate = {
      id: createCandidateId(candidateName, index),
      name: candidateName,
      requestedNiche: requestedNiche || undefined,
      problemStatement: issue,
      oneLiner: `AI-first product to eliminate "${issue}".`,
      aiBuildAngle: gap,
      icp: "Operators and founders with recurring workflow pain",
      audience: "Operators and founders",
      whyNow: toSafeString(
        trendSynthesis.summary,
        "Recent 30-day evidence shows persistent pain and demand for better tools.",
      ),
      recommendation: "Launch a narrow MVP, then validate willingness to pay through fast pilots.",
      score: baseScore,
      verdict,
      demand: {
        trendSummary: toSafeString(trendSynthesis.summary, "Evidence indicates sustained demand."),
        urgencyDrivers: [issue].slice(0, 6),
        buyingSignals: trendSynthesis.keyTrends.slice(0, 6),
        searchKeywords: uniqueStrings([topic, ...extractThemesFromHeadlines([issue, gap], 4), "ai copilot", "automation"]).slice(0, 10),
      },
      landscape: {
        competitionLevel: "medium",
        incumbentTypes: ["manual service providers", "point tools"],
        whitespace: [gap],
        beachheadWedge: "Faster onboarding and lower operational friction.",
      },
      businessModel: {
        pricingModel: "SaaS subscription + onboarding fee",
        priceAnchor: "$49-$299 per month",
        timeToFirstDollar: "2-6 weeks",
        expectedGrossMargin: "70%+",
      },
      goToMarket: {
        channels: ["Reddit communities", "X operator circles", "high-intent search capture"],
        offerHook: `Automate "${issue}" in under 7 days.`,
        salesMotion: "Founder-led outreach to operators already discussing this pain",
        retentionLoop: "Weekly ROI reporting tied to hours and errors reduced",
      },
      execution: {
        buildComplexity: "medium",
        stackRecommendation: "Next.js + workflow automation engine + LLM APIs",
        mvpScope: ["intake", "classification", "automation output", "impact dashboard"],
        automationLevers: ["classification", "prioritization", "follow-up generation"],
        moatLevers: ["workflow-specific data loops", "playbook tuning"],
      },
      outcomes: {
        timeToFirstDollarDays: 60,
        gtmDifficulty: 5,
        integrationComplexity: 5,
        weightedScore: computeOutcomeScore({
          timeToFirstDollarDays: 60,
          gtmDifficulty: 5,
          integrationComplexity: 5,
        }),
      },
      competitors: [],
      personaVariants: normalizePersonaVariants([]),
      validationPlan: [
        {
          experiment: "Run 10 interviews tied to top cited complaints",
          successMetric: "At least 5 buyers confirm urgency and budget",
          effort: "low",
        },
        {
          experiment: "Pilot MVP with 3 design partners",
          successMetric: "At least 2 pilots convert to paid",
          effort: "medium",
        },
      ],
      risks: ["Evidence quality can vary by sub-segment.", "Signal quality may shift as trends change."],
      killCriteria: ["Kill if no paid pilot closes within 45 days."],
      proofPoints,
      checks: {
        spending: {
          passed: spendingPassed,
          estimatedAnnualSpendUsd: spendingPassed ? 500 : null,
          thresholdUsd: 500,
          evidence: spendingEvidence.slice(0, 8),
          claims: spendingEvidence.slice(0, 8).map((claim, claimIndex) => ({
            claim,
            confidence: claimIndex === 0 ? "high" : "med",
            sourceUrl: proofPoints[claimIndex]?.sourceUrl,
          })),
          offerings: [],
        },
        pain: {
          passed: painPassed,
          recurringComplaintCount: Math.max(3, painEvidence.length),
          complaintThemes: [issue].slice(0, 8),
          evidence: painEvidence.slice(0, 8),
          claims: painEvidence.slice(0, 8).map((claim, claimIndex) => ({
            claim,
            confidence: claimIndex === 0 ? "high" : "med",
            sourceUrl: proofPoints[(claimIndex + 1) % proofPoints.length]?.sourceUrl,
          })),
        },
        room: {
          passed: roomPassed,
          communityName: "Cross-platform operator communities",
          platform: "Reddit/X",
          members: null,
          engagementSignal: roomEvidence[0] || "Observed active engagement in latest 30-day evidence.",
          evidence: roomEvidence.slice(0, 8),
          claims: roomEvidence.slice(0, 8).map((claim, claimIndex) => ({
            claim,
            confidence: claimIndex === 0 ? "high" : "med",
            sourceUrl: proofPoints[(claimIndex + 2) % proofPoints.length]?.sourceUrl,
          })),
          url: proofPoints[0]?.sourceUrl ?? "",
        },
      },
      sources: proofPoints.map((item) => ({
        title: item.claim.slice(0, 80),
        url: item.sourceUrl,
        note: item.claim,
        type: "general",
        date: item.date,
      })),
    };

    results.push(fallback);
  }

  return dedupeCandidates(results).slice(0, maxCandidates);
}

function normalizeCompetitors(value: unknown, max: number): NicheCandidate["competitors"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const typed = item as RawCompetitor;
      const url = toSafeString(typed.url, "");
      if (!hasValidUrl(url)) {
        return null;
      }

      return {
        name: toSafeString(typed.name, "Unknown competitor"),
        url,
        pricingSummary: toSafeString(typed.pricingSummary, "Pricing details not available."),
        onboardingFriction: toSafeString(typed.onboardingFriction, "Setup details not available."),
        reviewSentiment: toSafeString(typed.reviewSentiment, "Sentiment data not available."),
        confidence: normalizeEvidenceConfidence(typed.confidence),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, max);
}

function rankCandidatesByOutcomes(candidates: NicheCandidate[]) {
  const enriched = candidates.map((candidate) => {
    const outcomes = {
      ...candidate.outcomes,
      weightedScore: computeOutcomeScore(candidate.outcomes),
    };

    return {
      ...candidate,
      outcomes,
      killCriteria: autoKillCriteria(candidate),
    };
  });

  return [...enriched].sort((a, b) => compositeRankScore(b) - compositeRankScore(a));
}

function compositeRankScore(candidate: NicheCandidate) {
  return candidate.score * 0.65 + candidate.outcomes.weightedScore * 0.35;
}

function computeOutcomeScore(value: {
  timeToFirstDollarDays: number;
  gtmDifficulty: number;
  integrationComplexity: number;
}) {
  const timeComponent = Math.max(0, Math.min(10, 10 - (value.timeToFirstDollarDays - 14) / 35));
  const gtmComponent = 11 - clampInteger(value.gtmDifficulty, 1, 10, 5);
  const integrationComponent = 11 - clampInteger(value.integrationComplexity, 1, 10, 5);
  return Math.round(((timeComponent + gtmComponent + integrationComponent) / 30) * 100);
}

function autoKillCriteria(candidate: NicheCandidate) {
  const criteria = [...candidate.killCriteria];

  if (!criteria.length || candidate.checks.spending.estimatedAnnualSpendUsd === null) {
    criteria.push("Kill if you cannot verify 3 paying users above $50/mo within 30 days.");
  }

  if (candidate.outcomes.timeToFirstDollarDays > 120) {
    criteria.push("Kill if no signed pilot or paid waitlist before day 60.");
  }

  if (candidate.outcomes.gtmDifficulty >= 8) {
    criteria.push("Kill if CAC payback appears >6 months after initial outbound tests.");
  }

  if (candidate.outcomes.integrationComplexity >= 8) {
    criteria.push("Kill if MVP still needs custom integrations after week 4.");
  }

  if (!candidate.competitors.length) {
    criteria.push("Kill if competitor interviews do not reveal a clear wedge and switching trigger.");
  }

  return [...new Set(criteria)].slice(0, 8);
}

function extractThemesFromHeadlines(headlines: string[], max: number) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "your",
    "about",
    "into",
    "over",
    "under",
    "after",
    "before",
    "while",
    "have",
    "has",
    "had",
    "are",
    "was",
    "were",
    "will",
    "just",
    "more",
    "less",
    "new",
    "latest",
    "update",
    "updates",
    "today",
    "days",
    "last",
    "month",
    "weeks",
    "week",
    "ai",
  ]);

  const counts = new Map<string, number>();
  for (const headline of headlines) {
    const tokens = headline
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stopWords.has(token));
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([token]) => token);
}

function selectProofPointsForIssue({
  issue,
  refs,
  offset,
}: {
  issue: string;
  refs: EvidenceReference[];
  offset: number;
}) {
  const loweredIssueTokens = issue
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);

  const prioritized = [...refs].sort((a, b) => {
    const aText = a.headline.toLowerCase();
    const bText = b.headline.toLowerCase();
    const aMatches = loweredIssueTokens.filter((token) => aText.includes(token)).length;
    const bMatches = loweredIssueTokens.filter((token) => bText.includes(token)).length;
    return bMatches - aMatches;
  });

  const rotated = [...prioritized.slice(offset), ...prioritized.slice(0, offset)];
  return rotated.slice(0, 3).map((item) => ({
    claim: item.headline.slice(0, 220),
    sourceUrl: item.url,
    date: item.date,
    sourceType: item.sourceType,
  })) satisfies NicheProofPoint[];
}

function isSpendingSignal(text: string) {
  return /\$|price|pricing|cost|expensive|budget|roi|paid|spend|subscription/i.test(text);
}

function isPainSignal(text: string) {
  return /complaint|pain|friction|slow|manual|failure|fail|issue|problem|delay|denied|stuck|broken/i.test(text);
}

function isRoomSignal(text: string) {
  return /community|forum|subreddit|reddit|x|twitter|engagement|comments|followers|members|group/i.test(text);
}

function buildFallbackNameFromIssue(issue: string, topic: string) {
  const tokens = issue
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);

  const filtered = tokens.filter((token) => !["this", "that", "with", "from", "into", "over"].includes(token));
  const stem = filtered.slice(0, 3).join(" ");
  if (!stem) {
    return `${topic} workflow copilot`;
  }
  return `${stem} copilot`;
}

function extractIssueSignals(refs: EvidenceReference[]) {
  const issueKeywords = [
    "complaint",
    "pain",
    "friction",
    "slow",
    "failed",
    "failure",
    "expensive",
    "cost",
    "manual",
    "backlog",
    "denied",
    "delay",
    "stuck",
    "broken",
    "problem",
    "issue",
    "need better",
    "request",
  ];

  const extracted = refs
    .map((ref) => ref.headline.trim())
    .filter(Boolean)
    .filter((headline) => {
      const lowered = headline.toLowerCase();
      return issueKeywords.some((token) => lowered.includes(token));
    });

  if (extracted.length) {
    return uniqueStrings(extracted);
  }

  return uniqueStrings(refs.map((ref) => ref.headline.trim()).filter(Boolean));
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

function getCompetitorTimeout(mode: NicheResearchDepth) {
  if (mode === "quick") {
    return 20000;
  }
  if (mode === "deep") {
    return 90000;
  }
  return 70000;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }

  const error = new Error("Research aborted");
  error.name = "AbortError";
  throw error;
}

function isAbortLikeError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function toAbortError(error?: unknown) {
  if (isAbortLikeError(error)) {
    if (error instanceof Error) {
      return error;
    }
  }

  const abortError = new Error("Research aborted");
  abortError.name = "AbortError";
  return abortError;
}

function toRecoveryReason(error: unknown) {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message ? message : "unknown error";
  }

  const fallback = String(error ?? "").trim();
  return fallback || "unknown error";
}

function createEmptyCheckpoint({
  niche,
  mode,
  range,
  queries,
  totalSteps,
}: {
  niche: string;
  mode: NicheResearchDepth;
  range: { from: string; to: string };
  queries: string[];
  totalSteps: number;
}): NicheResearchCheckpoint {
  return {
    version: 1,
    niche,
    mode,
    startedAt: Date.now(),
    range,
    queries,
    totalSteps,
    completedSteps: 0,
    completedQueryCount: 0,
    usageTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      calls: 0,
    },
    allRaw: {
      reddit: [],
      x: [],
      web: [],
    },
    finalCandidates: null,
    enrichedCandidates: null,
    trendNews: null,
    finalReport: null,
    updatedAt: new Date().toISOString(),
  };
}

async function persistCheckpoint({
  resumeKey,
  checkpoint,
}: {
  resumeKey: string;
  checkpoint: NicheResearchCheckpoint;
}) {
  if (!resumeKey) {
    return;
  }

  await saveNicheCheckpoint(resumeKey, {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  });
}

function sameStringArray(a: string[], b: string[]) {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((item, index) => item === b[index]);
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

function toSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toTitleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
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

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(value.trim());
  }
  return output;
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

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.round(parsed);
  return Math.max(min, Math.min(max, rounded));
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
