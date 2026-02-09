import { getDateRange } from "@/lib/server/date";
import {
  NicheResearchCheckpoint,
  loadNicheCheckpoint,
  saveNicheRecoveryArtifact,
  saveNicheCheckpoint,
} from "@/lib/server/niche-checkpoint";
import {
  applyDateAndConfidenceReddit,
  applyDateAndConfidenceYouTube,
  applyDateAndConfidenceWeb,
  applyDateAndConfidenceX,
  dedupeReddit,
  dedupeYouTube,
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
import { scoreReddit, scoreWeb, scoreX, scoreYouTube } from "@/lib/server/scoring";
import { searchReddit, searchWeb, searchX, searchYouTube } from "@/lib/server/search";
import {
  NicheCandidate,
  NicheResearchDepth,
  NicheResearchProgressEvent,
  NicheResearchResponse,
  NicheTrendNews,
} from "@/lib/niche-types";
import { RedditItem, WebItem, XItem, YouTubeItem } from "@/lib/types";

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

interface RawTrendNews {
  title?: unknown;
  url?: unknown;
  summary?: unknown;
  whyItMatters?: unknown;
  date?: unknown;
  confidence?: unknown;
}

interface RawTrendNewsOutput {
  items?: RawTrendNews[];
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

interface OpenRouterResponsesResponse {
  output?: unknown;
  choices?: unknown;
  usage?: Record<string, unknown>;
}

const VALIDATE_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";
const COMPETITOR_MODEL_DEFAULT = "openai/gpt-5.2:online";

type SearchResultShape = {
  reddit: Awaited<ReturnType<typeof searchReddit>>["items"];
  x: Awaited<ReturnType<typeof searchX>>["items"];
  web: Awaited<ReturnType<typeof searchWeb>>["items"];
  youtube: Awaited<ReturnType<typeof searchYouTube>>["items"];
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
    estimateMs: 840000,
    discoveryQueries: [
      "operators paying monthly for tools while complaining about repetitive manual workflows and slow revenue ops",
      "teams asking for alternatives because current software is expensive missing automation and hard to onboard",
    ],
  },
  default: {
    candidateCount: 7,
    perSourceLimit: 16,
    validateMaxTokens: 4200,
    estimateMs: 1500000,
    discoveryQueries: [
      "operators paying monthly for tools while complaining about repetitive manual workflows and slow revenue ops",
      "reddit and x posts where people say frustrated wish there was or looking for better tools in operations",
      "founders sharing manual workarounds spreadsheet workflows and hiring virtual assistants for tasks that could be automated",
    ],
  },
  deep: {
    candidateCount: 10,
    perSourceLimit: 24,
    validateMaxTokens: 5800,
    estimateMs: 2160000,
    discoveryQueries: [
      "operators paying monthly for tools while complaining about repetitive manual workflows and slow revenue ops",
      "reddit and x posts where people say frustrated wish there was or looking for better tools in operations",
      "founders sharing manual workarounds spreadsheet workflows and hiring virtual assistants for tasks that could be automated",
      "high-spend niches in healthcare insurance legal finance ecommerce with active communities and unresolved pain",
      "buyers asking for done-for-you services because software options are too generic and setup takes too long",
    ],
  },
};

const EXTRA_FOCUSED_QUERY_SUFFIXES = [
  "switching from",
  "alternatives too expensive",
  "manual workaround spreadsheet",
  "hiring VA for",
  "implementation pain onboarding",
  "churn reasons",
  "done for you service",
  "agency process bottleneck",
  "no code automation request",
  "community asking for template/tool",
];

const DISCOVERY_CONCURRENCY_BY_MODE: Record<NicheResearchDepth, number> = {
  quick: 2,
  default: 3,
  deep: 4,
};

const DISCOVERY_EARLY_STOP_RULES: Record<
  NicheResearchDepth,
  { minProcessedQueries: number; minSignalsTotal: number; minStrongSources: number; minSignalsPerStrongSource: number }
> = {
  quick: {
    minProcessedQueries: 3,
    minSignalsTotal: 26,
    minStrongSources: 3,
    minSignalsPerStrongSource: 4,
  },
  default: {
    minProcessedQueries: 5,
    minSignalsTotal: 44,
    minStrongSources: 3,
    minSignalsPerStrongSource: 7,
  },
  deep: {
    minProcessedQueries: 6,
    minSignalsTotal: 62,
    minStrongSources: 3,
    minSignalsPerStrongSource: 10,
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

  const queries = niche ? buildFocusedQueries(niche, mode) : config.discoveryQueries;
  const totalSteps = queries.length + 5;
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
        ? `Preparing research pipeline for ${niche}.`
        : "Preparing auto-discovery research pipeline.",
  );

  if (checkpoint.finalReport) {
    emit("complete", "Loaded completed research checkpoint.");
    return checkpoint.finalReport;
  }

  const allRawReddit: SearchResultShape["reddit"] = [...checkpoint.allRaw.reddit];
  const allRawX: SearchResultShape["x"] = [...checkpoint.allRaw.x];
  const allRawWeb: SearchResultShape["web"] = [...checkpoint.allRaw.web];
  const allRawYouTube: SearchResultShape["youtube"] = [...checkpoint.allRaw.youtube];
  let completedQueryCount = Math.min(checkpoint.completedQueryCount, queries.length);
  let finalCandidates = checkpoint.finalCandidates ? [...checkpoint.finalCandidates] : null;
  let enriched = checkpoint.enrichedCandidates ? [...checkpoint.enrichedCandidates] : null;
  let trendNews = checkpoint.trendNews ? [...checkpoint.trendNews] : null;
  const recoveryNotes = new Set<string>();
  const discoveryConcurrency = DISCOVERY_CONCURRENCY_BY_MODE[mode];

  while (completedQueryCount < queries.length) {
    throwIfAborted(abortSignal);
    const batchStart = completedQueryCount;
    const batchEnd = Math.min(queries.length, batchStart + discoveryConcurrency);
    const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, offset) => batchStart + offset);

    for (const index of batchIndices) {
      const query = queries[index];
      emit("discovering", describeQueryStep({ niche: niche || "this niche", query, index, total: queries.length }));
    }

    const batchResults = await Promise.all(
      batchIndices.map(async (index) => {
        const query = queries[index];
        const searchResult = await runThreeSourceSearch({
          query,
          mode,
          fromDate: range.from,
          toDate: range.to,
          signal: abortSignal,
        });
        throwIfAborted(abortSignal);

        return {
          index,
          searchResult,
        };
      }),
    );
    throwIfAborted(abortSignal);

    for (const { searchResult } of batchResults) {
      addUsage(usageTotals, searchResult.usage);
      allRawReddit.push(...searchResult.items.reddit);
      allRawX.push(...searchResult.items.x);
      allRawWeb.push(...searchResult.items.web);
      allRawYouTube.push(...searchResult.items.youtube);
    }

    completedQueryCount = batchEnd;
    completedSteps += batchResults.length;
    emit(
      "discovering",
      `Collected and scored fresh source signals for ${niche || "discovery mode"} (${completedSteps}/${totalSteps} steps).`,
    );

    if (niche && completedQueryCount < queries.length) {
      const earlyStop = evaluateDiscoveryEarlyStop({
        mode,
        processedQueryCount: completedQueryCount,
        totalQueryCount: queries.length,
        range,
        allRaw: {
          reddit: allRawReddit,
          x: allRawX,
          web: allRawWeb,
          youtube: allRawYouTube,
        },
      });

      if (earlyStop.shouldStop) {
        const skippedQueries = queries.length - completedQueryCount;
        completedQueryCount = queries.length;
        completedSteps += skippedQueries;
        emit(
          "discovering",
          `Evidence saturation reached (${earlyStop.summary}). Skipping ${skippedQueries} remaining query step${skippedQueries === 1 ? "" : "s"}.`,
        );
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
          youtube: [...allRawYouTube],
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

  const youtube = sortByScoreAndDate(
    dedupeYouTube(scoreYouTube(applyDateAndConfidenceYouTube(allRawYouTube, range.from, range.to))),
  ).slice(0, config.perSourceLimit);

  completedSteps += 1;
  emit("validating", "Validating candidates against spending, pain, and launch room checks...");
  throwIfAborted(abortSignal);

  if (!finalCandidates) {
    try {
      let candidates = await generateValidatedCandidates({
        niche,
        mode,
        range,
        candidateCount: config.candidateCount,
        reddit,
        x,
        web,
        youtube,
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
          youtube,
          retryMode: true,
          signal: abortSignal,
        });
        throwIfAborted(abortSignal);

        addUsage(usageTotals, retry.usage);
        candidates = retry;
      }

      const normalized = candidates.items
        .map((candidate, index) => normalizeCandidate(candidate, index, niche || null))
        .filter((candidate) => isLaunchReadyCandidate(candidate));

      finalCandidates = dedupeCandidates(normalized);
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
          youtube: [...allRawYouTube],
        },
        finalCandidates: [...finalCandidates],
        trendNews: trendNews ? [...trendNews] : null,
      },
    });
  }

  completedSteps += 1;
  emit("validating", "Running competitor scrape pass, evidence confidence, and persona variants...");
  throwIfAborted(abortSignal);

  if (!enriched) {
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
          youtube: [...allRawYouTube],
        },
        finalCandidates: [...(finalCandidates ?? [])],
        enrichedCandidates: [...enriched],
        trendNews: trendNews ? [...trendNews] : null,
      },
    });
  }

  const readyFinalCandidates = finalCandidates ?? [];
  const readyEnrichedCandidates = enriched ?? readyFinalCandidates;

  completedSteps += 1;
  emit("validating", "Computing outcome-based ranking and kill criteria...");

  const rankedCandidates = rankCandidatesByOutcomes(readyEnrichedCandidates);

  completedSteps += 1;
  emit("validating", `Researching latest trend/news for ${niche || "this niche"}...`);

  if (!trendNews) {
    try {
      const trendTopic = niche || rankedCandidates[0]?.requestedNiche || rankedCandidates[0]?.name || "ai workflow automation";
      const trendRun = await fetchNicheTrendNews({
        niche: trendTopic,
        mode,
        range,
        signal: abortSignal,
      });
      addUsage(usageTotals, trendRun.usage);
      trendNews = trendRun.items;
    } catch (error) {
      if (isAbortLikeError(error) || abortSignal?.aborted) {
        throw toAbortError(error);
      }
      trendNews = [];
      const message = `Trend/news lookup degraded (${toRecoveryReason(error)}). Returning results without trend/news.`;
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
          youtube: [...allRawYouTube],
        },
        finalCandidates: [...readyFinalCandidates],
        enrichedCandidates: [...readyEnrichedCandidates],
        trendNews: [...trendNews],
      },
    });
  }

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
      youtube: [...allRawYouTube],
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
    totalStepsByNiche.set(niche, buildFocusedQueries(niche, mode).length + 5);
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
              emitBatchProgress(
                event.stage,
                event.message,
                niche,
              );
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
    .filter((candidate) => isLaunchReadyCandidate(candidate));

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
  const [redditResult, xResult, webResult, youtubeResult] = await Promise.allSettled([
    searchReddit({ topic: query, depth: mode, fromDate, toDate, signal }),
    searchX({ topic: query, depth: mode, fromDate, toDate, signal }),
    searchWeb({ topic: query, depth: mode, fromDate, toDate, signal }),
    searchYouTube({ topic: query, depth: mode, fromDate, toDate, signal }),
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

  const items: SearchResultShape = {
    reddit: redditResult.status === "fulfilled" ? redditResult.value.items : [],
    x: xResult.status === "fulfilled" ? xResult.value.items : [],
    web: webResult.status === "fulfilled" ? webResult.value.items : [],
    youtube: youtubeResult.status === "fulfilled" ? youtubeResult.value.items : [],
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
  if (youtubeResult.status === "fulfilled") {
    addUsage(usage, { ...youtubeResult.value.usage, calls: 1 });
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
  youtube,
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
  youtube: YouTubeItem[];
  retryMode?: boolean;
  signal?: AbortSignal;
}) {
  const model = process.env.OPENROUTER_NICHE_MODEL ?? VALIDATE_MODEL_DEFAULT;
  const maxTokens = retryMode ? MODE_CONFIG[mode].validateMaxTokens + 1400 : MODE_CONFIG[mode].validateMaxTokens;
  const prompt = buildValidationPrompt({
    niche,
    mode,
    range,
    candidateCount,
    reddit,
    x,
    web,
    youtube,
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
  youtube,
  retryMode,
}: {
  niche: string;
  mode: NicheResearchDepth;
  range: { from: string; to: string };
  candidateCount: number;
  reddit: RedditItem[];
  x: XItem[];
  web: WebItem[];
  youtube: YouTubeItem[];
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
- Every candidate should be a business-ready idea dossier, not a brief summary.
- Include personaVariants for: agency-owner, operator, founder.
- Include killCriteria that indicate when to stop pursuing the idea if validation is weak.

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

YouTube evidence:
${compactYouTube(youtube)}

Return strict JSON:
{
  "candidates": [
    {
      "name": "string",
      "problemStatement": "string",
      "oneLiner": "string",
      "aiBuildAngle": "string",
      "icp": "string",
      "audience": "string",
      "whyNow": "string",
      "recommendation": "string",
      "score": 0,
      "verdict": "pass",
      "demand": {
        "trendSummary": "string",
        "urgencyDrivers": ["string"],
        "buyingSignals": ["string"],
        "searchKeywords": ["string"]
      },
      "landscape": {
        "competitionLevel": "low|medium|high",
        "incumbentTypes": ["string"],
        "whitespace": ["string"],
        "beachheadWedge": "string"
      },
      "businessModel": {
        "pricingModel": "string",
        "priceAnchor": "string",
        "timeToFirstDollar": "string",
        "expectedGrossMargin": "string"
      },
      "goToMarket": {
        "channels": ["string"],
        "offerHook": "string",
        "salesMotion": "string",
        "retentionLoop": "string"
      },
      "execution": {
        "buildComplexity": "low|medium|high",
        "stackRecommendation": "string",
        "mvpScope": ["string"],
        "automationLevers": ["string"],
        "moatLevers": ["string"]
      },
      "outcomes": {
        "timeToFirstDollarDays": 45,
        "gtmDifficulty": 1,
        "integrationComplexity": 1
      },
      "personaVariants": [
        {
          "persona": "agency-owner|operator|founder",
          "primaryPain": "string",
          "offerVariant": "string",
          "pricingAngle": "string",
          "bestChannel": "string"
        }
      ],
      "validationPlan": [
        {
          "experiment": "string",
          "successMetric": "string",
          "effort": "low|medium|high"
        }
      ],
      "risks": ["string"],
      "killCriteria": ["string"],
      "checks": {
        "spending": {
          "passed": true,
          "estimatedAnnualSpendUsd": 0,
          "thresholdUsd": 500,
          "evidence": ["string"],
          "claims": [
            {
              "claim": "string",
              "confidence": "high|med|low",
              "sourceUrl": "https://..."
            }
          ],
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
          "evidence": ["string"],
          "claims": [
            {
              "claim": "string",
              "confidence": "high|med|low",
              "sourceUrl": "https://..."
            }
          ]
        },
        "room": {
          "passed": true,
          "communityName": "string",
          "platform": "Reddit|Discord|Facebook|Slack|Forum|X",
          "members": 0,
          "engagementSignal": "string",
          "evidence": ["string"],
          "claims": [
            {
              "claim": "string",
              "confidence": "high|med|low",
              "sourceUrl": "https://..."
            }
          ],
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
- confidence must be one of: high, med, low.
- gtmDifficulty and integrationComplexity use scale 1 (easy) to 10 (hard).
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

function compactYouTube(items: YouTubeItem[]) {
  if (!items.length) {
    return "- none";
  }

  return items
    .slice(0, 24)
    .map((item) => {
      const views = item.engagement?.views ?? 0;
      const likes = item.engagement?.likes ?? 0;
      return `- [${item.date ?? "unknown"}] [views:${views} likes:${likes}] ${item.channel} ${item.title} (${item.url})`;
    })
    .join("\n");
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
  const normalizedNiche = niche.trim();
  const normalizedQuery = query.trim();
  const stepLabel = `Step ${index + 1}/${total}`;

  if (normalizedQuery === normalizedNiche) {
    return `${stepLabel} • Searching across Reddit, X, Web, and YouTube for buildable AI businesses in ${normalizedNiche}.`;
  }

  if (normalizedQuery.includes("consultant tool course pricing complaints community")) {
    return `${stepLabel} • Combing through results for ${normalizedNiche} consultant tools, courses, pricing, complaints, and communities.`;
  }

  if (normalizedQuery.endsWith("switching from")) {
    return `${stepLabel} • Finding switch intent and migration pain in ${normalizedNiche} workflows.`;
  }

  if (normalizedQuery.endsWith("alternatives too expensive")) {
    return `${stepLabel} • Looking for pricing frustration and willingness-to-pay signals in ${normalizedNiche}.`;
  }

  if (normalizedQuery.endsWith("manual workaround spreadsheet")) {
    return `${stepLabel} • Detecting manual spreadsheet workarounds that can be automated in ${normalizedNiche}.`;
  }

  if (normalizedQuery.endsWith("hiring VA for")) {
    return `${stepLabel} • Identifying tasks in ${normalizedNiche} where teams hire VAs instead of software.`;
  }

  if (normalizedQuery.endsWith("implementation pain onboarding")) {
    return `${stepLabel} • Mapping onboarding and implementation friction in ${normalizedNiche} tools.`;
  }

  if (normalizedQuery.endsWith("churn reasons")) {
    return `${stepLabel} • Extracting churn reasons and retention gaps in ${normalizedNiche} products.`;
  }

  if (normalizedQuery.endsWith("done for you service")) {
    return `${stepLabel} • Capturing demand for done-for-you alternatives in ${normalizedNiche}.`;
  }

  if (normalizedQuery.endsWith("agency process bottleneck")) {
    return `${stepLabel} • Surfacing agency bottlenecks and repeatable automations in ${normalizedNiche}.`;
  }

  if (normalizedQuery.endsWith("no code automation request")) {
    return `${stepLabel} • Finding explicit no-code automation requests in ${normalizedNiche} communities.`;
  }

  if (normalizedQuery.endsWith("community asking for template/tool")) {
    return `${stepLabel} • Spotting template/tool requests from active ${normalizedNiche} communities.`;
  }

  return `${stepLabel} • Searching multi-source signals for ${normalizedNiche}: ${normalizedQuery}.`;
}

function buildFocusedQueries(niche: string, mode: NicheResearchDepth) {
  const extraQueries = EXTRA_FOCUSED_QUERY_SUFFIXES.map((suffix) => `${niche} ${suffix}`);

  if (mode === "quick") {
    return [
      niche,
      `${niche} consultant tool course pricing complaints community`,
      ...extraQueries.slice(0, 4),
    ];
  }

  if (mode === "default") {
    return [
      niche,
      `${niche} consultant tool course pricing complaints community`,
      ...extraQueries,
    ];
  }

  return [
    niche,
    `${niche} consultant tool course pricing complaints community`,
    ...extraQueries,
    `${niche} frustrated wish there was looking for reddit discord forum`,
    `${niche} implementation pain onboarding integrations`,
  ];
}

function normalizeCandidate(raw: RawNicheCandidate, index: number, requestedNiche: string | null): NicheCandidate {
  const name = toSafeString(raw.name, `Niche ${index + 1}`);

  const thresholdUsd = Math.max(500, toNullableNumber(raw.checks?.spending?.thresholdUsd) ?? 500);
  const spendingEstimate = toNullableNumber(raw.checks?.spending?.estimatedAnnualSpendUsd);
  const spendingEvidence = toStringArray(raw.checks?.spending?.evidence, 8);
  const spendingClaims = normalizeEvidenceClaims(raw.checks?.spending?.claims, raw.checks?.spending?.evidence, "spending");
  const offerings = normalizeOfferings(raw.checks?.spending?.offerings);
  const hasPriceSignal =
    (spendingEstimate !== null && spendingEstimate >= thresholdUsd) ||
    offerings.some((offering) => (offering.annualPriceUsd ?? 0) >= thresholdUsd);
  const spendingPassed = toBoolean(raw.checks?.spending?.passed) && spendingEvidence.length > 0 && hasPriceSignal;

  const painEvidence = toStringArray(raw.checks?.pain?.evidence, 8);
  const painClaims = normalizeEvidenceClaims(raw.checks?.pain?.claims, raw.checks?.pain?.evidence, "pain");
  const recurringComplaintCount = toNullableNumber(raw.checks?.pain?.recurringComplaintCount) ?? 0;
  const complaintThemes = toStringArray(raw.checks?.pain?.complaintThemes, 8);
  const painPassed = toBoolean(raw.checks?.pain?.passed) && recurringComplaintCount >= 3 && painEvidence.length > 0 && complaintThemes.length > 0;

  const roomEvidence = toStringArray(raw.checks?.room?.evidence, 8);
  const roomClaims = normalizeEvidenceClaims(raw.checks?.room?.claims, raw.checks?.room?.evidence, "room");
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
        engagementSignal: engagementSignal || "No engagement signal provided.",
        evidence: roomEvidence,
        claims: roomClaims,
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
  return candidate.checks.spending.passed && candidate.checks.pain.passed && candidate.checks.room.passed;
}

function dedupeCandidates(candidates: NicheCandidate[]) {
  const seen = new Set<string>();
  const result: NicheCandidate[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.requestedNiche ?? "global"}|${candidate.name.toLowerCase().trim()}`;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }

  return result;
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
  const maxCompetitors = mode === "quick" ? 3 : mode === "default" ? 4 : 5;
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

async function fetchNicheTrendNews({
  niche,
  mode,
  range,
  signal,
}: {
  niche: string;
  mode: NicheResearchDepth;
  range: { from: string; to: string };
  signal?: AbortSignal;
}) {
  const model = process.env.OPENROUTER_WEB_MODEL ?? COMPETITOR_MODEL_DEFAULT;
  const maxItems = mode === "quick" ? 3 : mode === "deep" ? 7 : 5;

  try {
    return await runTrendNewsAttempt({
      niche,
      range,
      model,
      maxItems,
      timeoutMs: null,
      signal,
      compact: false,
    });
  } catch (error) {
    if (isAbortLikeError(error) || signal?.aborted || !isRetryableTrendError(error)) {
      throw error;
    }

    const fallbackMaxItems = Math.max(2, maxItems - 2);
    return runTrendNewsAttempt({
      niche,
      range,
      model,
      maxItems: fallbackMaxItems,
      timeoutMs: null,
      signal,
      compact: true,
    });
  }
}

async function runTrendNewsAttempt({
  niche,
  range,
  model,
  maxItems,
  timeoutMs,
  signal,
  compact,
}: {
  niche: string;
  range: { from: string; to: string };
  model: string;
  maxItems: number;
  timeoutMs: number | null;
  signal?: AbortSignal;
  compact: boolean;
}) {
  const prompt = buildTrendNewsPrompt({
    niche,
    range,
    maxItems,
    compact,
  });

  const response = await openRouterRequest<OpenRouterResponsesResponse>({
    path: "/responses",
    payload: {
      model,
      tools: [{ type: "web_search" }],
      input: [{ role: "user", content: prompt }],
    },
    timeoutMs,
    signal,
  });

  const text = extractTextFromOpenRouterResponse(response as Record<string, unknown>);
  const parsed = extractJsonObject<RawTrendNewsOutput>(text);
  const items = normalizeTrendNews(parsed?.items, maxItems);

  return {
    items,
    usage: {
      ...extractUsage(response as Record<string, unknown>),
      calls: 1,
    },
  };
}

function buildTrendNewsPrompt({
  niche,
  range,
  maxItems,
  compact,
}: {
  niche: string;
  range: { from: string; to: string };
  maxItems: number;
  compact: boolean;
}) {
  return `Find the latest trend/news updates for this niche and return structured JSON.

Niche: ${niche}
Date window preference: ${range.from} to ${range.to}

Return strict JSON:
{
  "items": [
    {
      "title": "string",
      "url": "https://...",
      "summary": "string",
      "whyItMatters": "string",
      "date": "YYYY-MM-DD or null",
      "confidence": "high|med|low"
    }
  ]
}

Rules:
- Prioritize the most recent and credible sources.
- Max ${maxItems} items.${compact ? "\n- Keep each summary very concise." : ""}
- JSON only`;
}

function evaluateDiscoveryEarlyStop({
  mode,
  processedQueryCount,
  totalQueryCount,
  range,
  allRaw,
}: {
  mode: NicheResearchDepth;
  processedQueryCount: number;
  totalQueryCount: number;
  range: { from: string; to: string };
  allRaw: SearchResultShape;
}) {
  const rules = DISCOVERY_EARLY_STOP_RULES[mode];
  if (processedQueryCount < rules.minProcessedQueries || processedQueryCount >= totalQueryCount) {
    return { shouldStop: false as const, summary: "" };
  }

  const redditCount = dedupeReddit(applyDateAndConfidenceReddit(allRaw.reddit, range.from, range.to)).length;
  const xCount = dedupeX(applyDateAndConfidenceX(allRaw.x, range.from, range.to)).length;
  const webCount = dedupeWeb(applyDateAndConfidenceWeb(allRaw.web, range.from, range.to)).length;
  const youtubeCount = dedupeYouTube(applyDateAndConfidenceYouTube(allRaw.youtube, range.from, range.to)).length;

  const counts = [redditCount, xCount, webCount, youtubeCount];
  const totalSignals = counts.reduce((sum, value) => sum + value, 0);
  const strongSources = counts.filter((value) => value >= rules.minSignalsPerStrongSource).length;

  const shouldStop = totalSignals >= rules.minSignalsTotal && strongSources >= rules.minStrongSources;
  const summary = `${totalSignals} total signals across ${strongSources} strong sources`;

  return {
    shouldStop,
    summary,
  };
}

function getCompetitorTimeout(mode: NicheResearchDepth) {
  if (mode === "quick") {
    return 45000;
  }
  if (mode === "deep") {
    return 90000;
  }
  return 70000;
}

function isRetryableTrendError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const source = error.message.toLowerCase();
  return (
    source.includes("timed out") ||
    source.includes("timeout") ||
    source.includes("rate limit") ||
    source.includes("too many requests") ||
    source.includes("temporarily")
  );
}

function normalizeTrendNews(value: unknown, max: number): NicheTrendNews[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const typed = item as RawTrendNews;
      const url = toSafeString(typed.url, "");
      if (!hasValidUrl(url)) {
        return null;
      }

      const title = toSafeString(typed.title, "").slice(0, 220);
      if (!title) {
        return null;
      }

      return {
        title,
        url,
        summary: toSafeString(typed.summary, "").slice(0, 420),
        whyItMatters: toSafeString(typed.whyItMatters, "").slice(0, 260),
        date: toNullableDateString(typed.date),
        confidence: normalizeEvidenceConfidence(typed.confidence),
      };
    })
    .filter((item): item is NicheTrendNews => Boolean(item))
    .slice(0, max);
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
      youtube: [],
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
