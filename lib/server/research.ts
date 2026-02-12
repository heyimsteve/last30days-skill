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
import { scoreReddit, scoreWeb, scoreX } from "@/lib/server/scoring";
import { SearchParams, searchReddit, searchWeb, searchX } from "@/lib/server/search";
import { synthesize } from "@/lib/server/synthesis";
import { ResearchResponse, SourceType, UsageBreakdown } from "@/lib/types";

export type ResearchDepth = "quick" | "default" | "deep";

export interface ResearchInput {
  topic: string;
  days: number;
  depth: ResearchDepth;
  sources: SourceType[];
}

export interface ResearchProgressEvent {
  stage: "starting" | "searching" | "processing" | "synthesizing" | "complete";
  message: string;
  elapsedMs: number;
  etaMs: number;
  completedSteps: number;
  totalSteps: number;
  sourceStatus: Partial<Record<SourceType, "pending" | "running" | "completed" | "failed">>;
}

export interface ResearchRunOptions {
  onProgress?: (event: ResearchProgressEvent) => void;
}

const MAX_ITEMS_BY_DEPTH: Record<ResearchDepth, number> = {
  quick: 12,
  default: 30,
  deep: 60,
};

const SOURCE_ESTIMATE_MS: Record<ResearchDepth, number> = {
  quick: 40000,
  default: 95000,
  deep: 165000,
};

const PROCESSING_ESTIMATE_MS = 6000;
const SYNTHESIS_ESTIMATE_MS = 35000;

export async function runResearch(input: ResearchInput, options: ResearchRunOptions = {}): Promise<ResearchResponse> {
  const { topic, days, depth, sources } = input;
  const { onProgress } = options;
  const startedAt = Date.now();
  const range = getDateRange(days);
  const errors: ResearchResponse["errors"] = {};

  const params: SearchParams = {
    topic,
    fromDate: range.from,
    toDate: range.to,
    depth,
  };

  const selectedSources = normalizeSources(sources);
  const totalSteps = selectedSources.length + 2;
  let completedSteps = 0;
  const sourceStatus: Partial<Record<SourceType, "pending" | "running" | "completed" | "failed">> = {};
  for (const source of selectedSources) {
    sourceStatus[source] = "pending";
  }

  const estimatedTotalMs =
    selectedSources.length * SOURCE_ESTIMATE_MS[depth] +
    PROCESSING_ESTIMATE_MS +
    SYNTHESIS_ESTIMATE_MS;

  const emitProgress = (
    stage: ResearchProgressEvent["stage"],
    message: string,
  ) => {
    if (!onProgress) {
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    onProgress({
      stage,
      message,
      elapsedMs,
      etaMs: Math.max(0, estimatedTotalMs - elapsedMs),
      completedSteps,
      totalSteps,
      sourceStatus: { ...sourceStatus },
    });
  };

  emitProgress("starting", "Preparing research pipeline...");

  let rawReddit: Awaited<ReturnType<typeof searchReddit>>["items"] = [];
  let rawX: Awaited<ReturnType<typeof searchX>>["items"] = [];
  let rawWeb: Awaited<ReturnType<typeof searchWeb>>["items"] = [];

  const usageByOperation: ResearchResponse["usage"]["byOperation"] = {};
  const promises: Array<Promise<void>> = [];

  if (selectedSources.includes("reddit")) {
    sourceStatus.reddit = "running";
    emitProgress("searching", "Searching Reddit...");

    promises.push(
      searchReddit(params)
        .then((result) => {
          rawReddit = result.items;
          usageByOperation.reddit = {
            ...result.usage,
            calls: 1,
            model: result.model,
          };
          sourceStatus.reddit = "completed";
        })
        .catch((error) => {
          errors.reddit = toErrorMessage(error);
          sourceStatus.reddit = "failed";
        })
        .finally(() => {
          completedSteps += 1;
          emitProgress(
            "searching",
            sourceStatus.reddit === "completed"
              ? `Reddit search complete (${rawReddit.length} items).`
              : "Reddit search failed.",
          );
        }),
    );
  }

  if (selectedSources.includes("x")) {
    sourceStatus.x = "running";
    emitProgress("searching", "Searching X...");

    promises.push(
      searchX(params)
        .then((result) => {
          rawX = result.items;
          usageByOperation.x = {
            ...result.usage,
            calls: 1,
            model: result.model,
          };
          sourceStatus.x = "completed";
        })
        .catch((error) => {
          errors.x = toErrorMessage(error);
          sourceStatus.x = "failed";
        })
        .finally(() => {
          completedSteps += 1;
          emitProgress(
            "searching",
            sourceStatus.x === "completed"
              ? `X search complete (${rawX.length} items).`
              : "X search failed.",
          );
        }),
    );
  }

  if (selectedSources.includes("web")) {
    sourceStatus.web = "running";
    emitProgress("searching", "Searching the web...");

    promises.push(
      searchWeb(params)
        .then((result) => {
          rawWeb = result.items;
          usageByOperation.web = {
            ...result.usage,
            calls: 1,
            model: result.model,
          };
          sourceStatus.web = "completed";
        })
        .catch((error) => {
          errors.web = toErrorMessage(error);
          sourceStatus.web = "failed";
        })
        .finally(() => {
          completedSteps += 1;
          emitProgress(
            "searching",
            sourceStatus.web === "completed"
              ? `Web search complete (${rawWeb.length} items).`
              : "Web search failed.",
          );
        }),
    );
  }

  await Promise.all(promises);

  const limit = MAX_ITEMS_BY_DEPTH[depth];

  emitProgress("processing", "Filtering, scoring, and deduping results...");

  const reddit = sortByScoreAndDate(
    dedupeReddit(
      scoreReddit(
        applyDateAndConfidenceReddit(rawReddit, range.from, range.to),
      ),
    ),
  ).slice(0, limit);

  const x = sortByScoreAndDate(
    dedupeX(
      scoreX(
        applyDateAndConfidenceX(rawX, range.from, range.to),
      ),
    ),
  ).slice(0, limit);

  const web = sortByScoreAndDate(
    dedupeWeb(
      scoreWeb(
        applyDateAndConfidenceWeb(rawWeb, range.from, range.to),
      ),
    ),
  ).slice(0, limit);

  completedSteps += 1;
  emitProgress("processing", "Result processing complete.");

  let synthesis: ResearchResponse["synthesis"] = null;
  const hasAnyResults = reddit.length > 0 || x.length > 0 || web.length > 0;

  if (hasAnyResults) {
    emitProgress("synthesizing", "Synthesizing findings with Claude...");
    try {
      const synthRun = await synthesize(topic, reddit, x, web);
      synthesis = synthRun.synthesis;
      usageByOperation.synthesis = {
        ...synthRun.usage,
        calls: 1,
        model: synthRun.model,
      };
    } catch (error) {
      errors.synthesis = toErrorMessage(error);
    }
  }

  completedSteps += 1;
  if (!hasAnyResults) {
    emitProgress("synthesizing", "Skipping synthesis because no results were found.");
  }

  const usage = sumUsage(usageByOperation);
  const elapsedMs = Date.now() - startedAt;

  emitProgress("complete", "Research complete.");

  return {
    topic,
    range,
    sources: selectedSources,
    reddit,
    x,
    web,
    synthesis,
    errors,
    stats: {
      total: reddit.length + x.length + web.length,
      reddit: reddit.length,
      x: x.length,
      web: web.length,
      elapsedMs,
      generatedAt: new Date().toISOString(),
    },
    usage,
  };
}

function normalizeSources(sources: SourceType[]): SourceType[] {
  const set = new Set<SourceType>();
  for (const source of sources) {
    if (source === "reddit" || source === "x" || source === "web") {
      set.add(source);
    }
  }

  if (!set.size) {
    return ["reddit", "x", "web"];
  }

  return Array.from(set);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Request timed out. Try quick depth or fewer sources.";
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("aborted")) {
      return "Request timed out. Try quick depth or fewer sources.";
    }
    return error.message;
  }
  return String(error);
}

function sumUsage(byOperation: ResearchResponse["usage"]["byOperation"]): ResearchResponse["usage"] {
  const parts = Object.values(byOperation).filter((part): part is UsageBreakdown => Boolean(part));

  return {
    inputTokens: sum(parts.map((part) => part.inputTokens)),
    outputTokens: sum(parts.map((part) => part.outputTokens)),
    totalTokens: sum(parts.map((part) => part.totalTokens)),
    costUsd: sum(parts.map((part) => part.costUsd)),
    calls: sum(parts.map((part) => part.calls)),
    byOperation,
  };
}

function sum(values: number[]) {
  return values.reduce((acc, value) => acc + value, 0);
}
