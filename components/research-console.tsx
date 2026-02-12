"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  MarketAnalysisResult,
  NichePlanResponse,
  NicheResearchDepth,
  NicheResearchProgressEvent,
  NicheResearchResponse,
  PlanOutputType,
  PromoPackResponse,
  TokenUsageSummary,
} from "@/lib/niche-types";

const DEFAULT_SUGGESTED_NICHES = [
  "Dental insurance claim denials",
  "Shopify refund abuse detection",
  "Home services quote follow-up",
  "Creator sponsorship operations",
  "Legal intake triage automation",
  "Property management maintenance routing",
  "Clinic prior auth paperwork",
  "Freight broker load follow-ups",
];

const PLAN_SEQUENCE: PlanOutputType[] = ["prd", "market", "plan"];
const ESTIMATED_PRD_MS = 105000;
const ESTIMATED_MARKET_MS = 105000;
const ESTIMATED_PLAN_MS = 105000;
const APP_NAME = "Last30Days Opportunity Studio";
const APP_ID = "last30days-opportunity-studio";
type AppId = typeof APP_ID | "niche-validator-studio";

interface StreamPayload {
  type: "ready" | "progress" | "result" | "error";
  progress?: NicheResearchProgressEvent;
  report?: NicheResearchResponse;
  error?: string;
}

interface PlanGenerationState {
  stage: "idle" | "running" | "complete" | "error";
  message: string;
  completed: number;
  total: number;
  startedAt: number | null;
  etaTargetAt: number | null;
}

interface ExportEnvelope {
  app: AppId;
  version: 1;
  exportedAt: string;
  report: NicheResearchResponse;
}

interface ImportedRecoveryCheckpoint {
  version: 1;
  niche: string;
  mode: NicheResearchDepth;
  startedAt: number;
  queries: string[];
  totalSteps: number;
  completedSteps: number;
  usageTotals: TokenUsageSummary;
  allRaw: {
    reddit: unknown[];
    x: unknown[];
    web: unknown[];
    youtube?: unknown[];
  };
}

interface RecoveryArtifactEnvelope {
  app?: AppId;
  kind: "recovery-artifact";
  version: 1;
  checkpointKey?: string;
  report?: unknown;
  checkpoint?: unknown;
  recoveryMessages?: unknown;
}

interface ImportedRecoverySnapshot {
  checkpointKey: string;
  checkpoint: ImportedRecoveryCheckpoint;
  recoveryMessages: string[];
}

type ImportMode = "report" | "recovery";

interface ResearchRunConfig {
  niche: string;
  depth: NicheResearchDepth;
}

type NicheRunStatus = "queued" | "running" | "paused" | "stopped" | "completed" | "failed";

interface NicheRunState {
  id: string;
  niche: string;
  query: string;
  status: NicheRunStatus;
  progress: NicheResearchProgressEvent | null;
  report: NicheResearchResponse | null;
  error: string | null;
  estimatedTotalSteps: number;
}

interface BudgetEstimate {
  niches: number;
  perNicheTokens: number;
  perNicheCostUsd: number;
  tokens: number;
  tokensLow: number;
  tokensHigh: number;
  costUsd: number;
  costLowUsd: number;
  costHighUsd: number;
}

interface SuggestionRequestOptions {
  basedOnNiches?: string[];
}

const EMPTY_PLAN_STATE: PlanGenerationState = {
  stage: "idle",
  message: "",
  completed: 0,
  total: PLAN_SEQUENCE.length,
  startedAt: null,
  etaTargetAt: null,
};

export function ResearchConsole() {
  const [nicheInput, setNicheInput] = useState("");
  const [depth, setDepth] = useState<NicheResearchDepth>("default");

  const [loading, setLoading] = useState(false);
  const [nicheRuns, setNicheRuns] = useState<NicheRunState[]>([]);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());

  const [report, setReport] = useState<NicheResearchResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");

  const [planning, setPlanning] = useState(false);
  const [planResults, setPlanResults] = useState<Partial<Record<PlanOutputType, NichePlanResponse>>>({});
  const [planState, setPlanState] = useState<PlanGenerationState>(EMPTY_PLAN_STATE);
  const [marketAnalysisLoading, setMarketAnalysisLoading] = useState(false);
  const [marketAnalysisError, setMarketAnalysisError] = useState<string | null>(null);
  const [marketAnalysisByCandidate, setMarketAnalysisByCandidate] = useState<Record<string, MarketAnalysisResult>>({});
  const [promoPackLoading, setPromoPackLoading] = useState(false);
  const [promoPackError, setPromoPackError] = useState<string | null>(null);
  const [promoPackByCandidate, setPromoPackByCandidate] = useState<Record<string, PromoPackResponse>>({});

  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);

  const [suggestedNiches, setSuggestedNiches] = useState<string[]>(DEFAULT_SUGGESTED_NICHES);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  const importFileRef = useRef<HTMLInputElement>(null);
  const recoveryImportFileRef = useRef<HTMLInputElement>(null);
  const runControllersRef = useRef<Map<string, AbortController>>(new Map());
  const runIntentRef = useRef<Map<string, "none" | "pause" | "stop">>(new Map());

  useEffect(() => {
    if (!loading && !planning) {
      return;
    }

    const timer = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading, planning]);

  useEffect(() => {
    void regenerateSuggestions();
  }, []);

  useEffect(() => {
    const controllers = runControllersRef.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  const visibleCandidates = useMemo(() => {
    if (!report) {
      return [];
    }

    return report.candidates;
  }, [report]);

  const selectedCandidate = useMemo(() => {
    if (!visibleCandidates.length) {
      return null;
    }

    return visibleCandidates.find((candidate) => candidate.id === selectedId) ?? visibleCandidates[0];
  }, [selectedId, visibleCandidates]);

  const selectedTrendNews = useMemo(() => {
    if (!report) {
      return [];
    }

    const candidateNiche = selectedCandidate?.requestedNiche?.trim().toLowerCase();
    const run =
      report.runs.find((entry) => candidateNiche && entry.niche.trim().toLowerCase() === candidateNiche) ??
      report.runs.find((entry) => entry.status === "completed");

    return run?.trendNews ?? [];
  }, [report, selectedCandidate]);

  const selectedTrendSynthesis = useMemo(() => {
    if (!report || !selectedCandidate) {
      return null;
    }

    const candidateNiche = selectedCandidate.requestedNiche?.trim().toLowerCase();
    const run =
      report.runs.find((entry) => candidateNiche && entry.niche.trim().toLowerCase() === candidateNiche) ??
      report.runs.find((entry) => entry.status === "completed");

    return run?.trendSynthesis ?? null;
  }, [report, selectedCandidate]);

  const selectedMarketAnalysis = useMemo(() => {
    if (!selectedCandidate) {
      return null;
    }
    return marketAnalysisByCandidate[selectedCandidate.id] ?? null;
  }, [marketAnalysisByCandidate, selectedCandidate]);

  const selectedPromoPack = useMemo(() => {
    if (!selectedCandidate) {
      return null;
    }
    return promoPackByCandidate[selectedCandidate.id] ?? null;
  }, [promoPackByCandidate, selectedCandidate]);

  useEffect(() => {
    if (!visibleCandidates.length) {
      setSelectedId("");
      return;
    }

    if (!selectedId || !visibleCandidates.some((candidate) => candidate.id === selectedId)) {
      setSelectedId(visibleCandidates[0].id);
    }
  }, [selectedId, visibleCandidates]);

  const elapsedMs = runStartedAt ? Math.max(0, clockNow - runStartedAt) : 0;
  const planElapsedMs = planState.startedAt ? Math.max(0, clockNow - planState.startedAt) : 0;
  const planRemainingMs = planState.etaTargetAt ? Math.max(0, planState.etaTargetAt - clockNow) : 0;
  const planProgressPercent = planState.total
    ? Math.round((planState.completed / planState.total) * 100)
    : 0;

  const inputNiches = parseCommaNiches(nicheInput);
  const budgetEstimate = useMemo<BudgetEstimate>(() => {
    return estimateBudget(inputNiches.length ? inputNiches.length : 1, depth);
  }, [depth, inputNiches.length]);

  const hasActiveRuns = useMemo(
    () => nicheRuns.some((run) => run.status === "queued" || run.status === "running"),
    [nicheRuns],
  );
  const hasPausedRuns = useMemo(() => nicheRuns.some((run) => run.status === "paused"), [nicheRuns]);
  const runBoardVisible = hasActiveRuns || hasPausedRuns;
  const runSummaryVisible = !runBoardVisible && nicheRuns.length > 0;
  const loadingLabel =
    nicheRuns.length > 1
      ? "Running parallel research..."
      : "Running research...";

  const aggregateProgress = useMemo(() => {
    const running = nicheRuns.filter((run) => run.status === "running").length;
    const complete = nicheRuns.filter((run) => run.status === "completed").length;
    const failed = nicheRuns.filter((run) => run.status === "failed" || run.status === "stopped").length;
    const paused = nicheRuns.filter((run) => run.status === "paused").length;

    const completedSteps = nicheRuns.reduce((sum, run) => {
      if (run.progress) {
        return sum + run.progress.completedSteps;
      }
      if (run.status === "completed") {
        return sum + run.estimatedTotalSteps;
      }
      return sum;
    }, 0);

    const totalSteps = nicheRuns.reduce((sum, run) => sum + run.estimatedTotalSteps, 0);
    const etaMs = nicheRuns.reduce((max, run) => {
      if (run.status !== "running") {
        return max;
      }
      return Math.max(max, run.progress?.etaMs ?? 0);
    }, 0);

    const lead = nicheRuns.find((run) => run.status === "running" && run.progress?.message)?.progress?.message;

    return {
      running,
      complete,
      failed,
      paused,
      completedSteps,
      totalSteps,
      etaMs,
      percent: totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0,
      message:
        lead ||
        (running
          ? running > 1
            ? `Running ${running} niche workers in parallel.`
            : "Running research."
          : paused
            ? "All running work is paused."
            : complete || failed
              ? "Research workers finished."
              : "Preparing niche workers..."),
    };
  }, [nicheRuns]);

  useEffect(() => {
    const hasActive = nicheRuns.some((run) => run.status === "queued" || run.status === "running");
    const hasPaused = nicheRuns.some((run) => run.status === "paused");
    setLoading(hasActive);

    if (hasActive || hasPaused) {
      return;
    }

    const completedReports = nicheRuns
      .filter((run) => run.status === "completed" && run.report)
      .map((run) => run.report as NicheResearchResponse);

    if (!completedReports.length) {
      return;
    }

    setReport(combineReportsFromRuns(completedReports, nicheRuns, depth));
  }, [depth, nicheRuns]);

  async function startResearchRun(run: ResearchRunConfig, runId: string) {
    const controller = new AbortController();
    runControllersRef.current.set(runId, controller);
    runIntentRef.current.set(runId, "none");

    setNicheRuns((current) =>
      current.map((entry) =>
        entry.id === runId
          ? {
              ...entry,
              status: "running",
              progress: null,
              error: null,
              report: null,
            }
          : entry,
      ),
    );

    try {
      const response = await fetch("/api/research/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          niche: run.niche,
          depth: run.depth,
          resumeKey: runId,
        }),
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        let message = "Niche validation request failed.";
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as { error?: string };
          message = payload.error ?? message;
        }

        setNicheRuns((current) =>
          current.map((entry) =>
            entry.id === runId
              ? toFailedRunState(entry, message)
              : entry,
          ),
        );
        return;
      }

      const body = response.body;
      if (!body) {
        setNicheRuns((current) =>
          current.map((entry) =>
            entry.id === runId
              ? toFailedRunState(entry, "No stream received from niche validator endpoint.")
              : entry,
          ),
        );
        return;
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotResult = false;
      let gotError = false;

      while (true) {
        if (controller.signal.aborted) {
          break;
        }

        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) {
            break;
          }

          const chunk = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);

          if (!chunk) {
            continue;
          }

          const line = chunk
            .split("\n")
            .find((entry) => entry.startsWith("data:"));

          if (!line) {
            continue;
          }

          let payload: StreamPayload;
          try {
            payload = JSON.parse(line.slice(5).trim()) as StreamPayload;
          } catch {
            continue;
          }

          if (payload.type === "progress" && payload.progress) {
            setNicheRuns((current) =>
              current.map((entry) =>
                entry.id === runId
                  ? entry.status !== "queued" && entry.status !== "running"
                    ? entry
                    : {
                        ...entry,
                        progress: payload.progress ?? null,
                        status: "running",
                      }
                  : entry,
              ),
            );
            continue;
          }

          if (payload.type === "result" && payload.report) {
            gotResult = true;
            setNicheRuns((current) =>
              current.map((entry) =>
                entry.id === runId
                  ? entry.status === "failed" || entry.status === "stopped"
                    ? entry
                    : (() => {
                        const runWarning = payload.report?.runs[0]?.error ?? null;
                        return {
                        ...entry,
                        status: "completed",
                        report: payload.report ?? null,
                        progress: {
                          stage: "complete",
                          message: runWarning
                            ? `Niche validation complete with recovery notes.`
                            : "Niche validation complete.",
                          elapsedMs: payload.report?.stats.elapsedMs ?? entry.progress?.elapsedMs ?? 0,
                          etaMs: 0,
                          completedSteps: entry.estimatedTotalSteps,
                          totalSteps: entry.estimatedTotalSteps,
                        },
                        error: runWarning,
                        };
                      })()
                  : entry,
              ),
            );
            continue;
          }

          if (payload.type === "error") {
            gotError = true;
            setNicheRuns((current) =>
              current.map((entry) =>
                entry.id === runId
                  ? toFailedRunState(entry, payload.error ?? "Niche validation failed.")
                  : entry,
              ),
            );
          }
        }
      }

      if (!gotResult && !gotError && !controller.signal.aborted) {
        setNicheRuns((current) =>
          current.map((entry) =>
            entry.id === runId
              ? toFailedRunState(entry, "Validation stream ended before a final result was returned.")
              : entry,
          ),
        );
      }
    } catch (requestError) {
      if (
        (requestError instanceof DOMException && requestError.name === "AbortError") ||
        (requestError instanceof Error && requestError.name === "AbortError")
      ) {
        return;
      }

      const message = requestError instanceof Error ? requestError.message : "Unexpected request failure.";
      setNicheRuns((current) =>
        current.map((entry) =>
          entry.id === runId
            ? toFailedRunState(entry, message)
            : entry,
        ),
      );
    } finally {
      const intent = runIntentRef.current.get(runId) ?? "none";
      runControllersRef.current.delete(runId);
      runIntentRef.current.set(runId, "none");

      if (intent === "pause") {
        setNicheRuns((current) =>
          current.map((entry) =>
            entry.id === runId && entry.status !== "completed"
              ? {
                  ...entry,
                  status: "paused",
                  progress: {
                    stage: "discovering",
                    message: "Paused by user.",
                    elapsedMs: entry.progress?.elapsedMs ?? 0,
                    etaMs: 0,
                    completedSteps: entry.progress?.completedSteps ?? 0,
                    totalSteps: entry.progress?.totalSteps ?? entry.estimatedTotalSteps,
                  },
                }
              : entry,
          ),
        );
      }

      if (intent === "stop") {
        setNicheRuns((current) =>
          current.map((entry) =>
            entry.id === runId && entry.status !== "completed"
              ? {
                  ...entry,
                  status: "stopped",
                  progress: {
                    stage: "complete",
                    message: "Stopped by user.",
                    elapsedMs: entry.progress?.elapsedMs ?? 0,
                    etaMs: 0,
                    completedSteps: entry.progress?.completedSteps ?? 0,
                    totalSteps: entry.progress?.totalSteps ?? entry.estimatedTotalSteps,
                  },
                  error: "Stopped by user",
                }
              : entry,
          ),
        );
      }
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    for (const controller of runControllersRef.current.values()) {
      controller.abort();
    }
    runControllersRef.current.clear();
    runIntentRef.current.clear();

    const targets = inputNiches.length ? inputNiches : [""];
    const startedAt = Date.now();
    const batchId = `${startedAt}-${Math.floor(Math.random() * 1_000_000)}`;
    const initialRuns = targets.map((niche, index) => createRunState(niche, depth, index, batchId));

    setRunStartedAt(startedAt);
    setClockNow(startedAt);
    setError(null);
    setPlanError(null);
    setImportNote(null);
    setPlanResults({});
    setPlanState(EMPTY_PLAN_STATE);
    setMarketAnalysisError(null);
    setPromoPackError(null);
    setMarketAnalysisByCandidate({});
    setPromoPackByCandidate({});
    setReport(null);
    setNicheRuns(initialRuns);

    await Promise.all(initialRuns.map((run) => startResearchRun({ niche: run.query, depth }, run.id)));
  }

  function pauseNiche(runId: string) {
    const controller = runControllersRef.current.get(runId);
    if (!controller) {
      return;
    }
    runIntentRef.current.set(runId, "pause");
    controller.abort();
  }

  function stopNiche(runId: string) {
    const controller = runControllersRef.current.get(runId);
    if (controller) {
      runIntentRef.current.set(runId, "stop");
      controller.abort();
      return;
    }

    setNicheRuns((current) =>
      current.map((entry) =>
        entry.id === runId && (entry.status === "paused" || entry.status === "queued")
          ? {
              ...entry,
              status: "stopped",
              error: "Stopped by user",
              progress: {
                stage: "complete",
                message: "Stopped by user.",
                elapsedMs: entry.progress?.elapsedMs ?? 0,
                etaMs: 0,
                completedSteps: entry.progress?.completedSteps ?? 0,
                totalSteps: entry.progress?.totalSteps ?? entry.estimatedTotalSteps,
              },
            }
          : entry,
      ),
    );
  }

  function resumeNiche(runId: string) {
    const run = nicheRuns.find((entry) => entry.id === runId);
    if (!run || run.status !== "paused") {
      return;
    }

    void startResearchRun({ niche: run.query, depth }, runId);
  }

  async function regenerateSuggestions(options: SuggestionRequestOptions = {}) {
    setSuggestionsLoading(true);
    try {
      const response = await fetch("/api/research/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: 8,
          niches: options.basedOnNiches ?? [],
        }),
      });

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as { suggestions?: unknown };
      if (!Array.isArray(payload.suggestions)) {
        return;
      }

      const suggestions = payload.suggestions
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
        .slice(0, 12);

      if (suggestions.length) {
        setSuggestedNiches(suggestions);
      }
    } finally {
      setSuggestionsLoading(false);
    }
  }

  function onGenerateFromNiches() {
    const niches = parseCommaNiches(nicheInput);
    if (!niches.length) {
      return;
    }
    void regenerateSuggestions({ basedOnNiches: niches });
  }

  function appendSuggestedNiche(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    const existing = parseCommaNiches(nicheInput);
    if (existing.includes(trimmed)) {
      return;
    }

    const next = [...existing, trimmed].join(", ");
    setNicheInput(next);
  }

  async function onGenerateOutputs() {
    if (!selectedCandidate) {
      setPlanError("Select a niche result first.");
      return;
    }

    const startedAt = Date.now();
    setPlanning(true);
    setPlanError(null);
    setPlanResults({});
    setPlanState({
      stage: "running",
      message: `Generating ${labelForPlanType(PLAN_SEQUENCE[0])}...`,
      completed: 0,
      total: PLAN_SEQUENCE.length,
      startedAt,
      etaTargetAt: startedAt + estimatePlanDurationForSequence(PLAN_SEQUENCE),
    });

    try {
      const nextResults: Partial<Record<PlanOutputType, NichePlanResponse>> = {};

      for (let index = 0; index < PLAN_SEQUENCE.length; index += 1) {
        const type = PLAN_SEQUENCE[index];
        const result = await requestPlan(selectedCandidate, type);
        nextResults[type] = result;
        setPlanResults({ ...nextResults });

        const remaining = PLAN_SEQUENCE.slice(index + 1);
        if (!remaining.length) {
          break;
        }

        setPlanState({
          stage: "running",
          message: `${labelForPlanType(type)} complete. Generating ${labelForPlanType(remaining[0])}...`,
          completed: index + 1,
          total: PLAN_SEQUENCE.length,
          startedAt,
          etaTargetAt: Date.now() + estimatePlanDurationForSequence(remaining),
        });
      }

      setPlanState({
        stage: "complete",
        message: "PRD, Market Plan, and Execution Plan are ready.",
        completed: PLAN_SEQUENCE.length,
        total: PLAN_SEQUENCE.length,
        startedAt,
        etaTargetAt: null,
      });
    } catch (requestError) {
      setPlanError(requestError instanceof Error ? requestError.message : "Unexpected planning failure.");
      setPlanState((current) => ({
        ...current,
        stage: "error",
        message: "Generation failed before all outputs completed.",
        etaTargetAt: null,
      }));
    } finally {
      setPlanning(false);
    }
  }

  async function onRunMarketAnalysis() {
    if (!selectedCandidate) {
      setMarketAnalysisError("Select a niche result first.");
      return;
    }

    setMarketAnalysisLoading(true);
    setMarketAnalysisError(null);

    try {
      const response = await fetch("/api/research/market-analysis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          candidate: selectedCandidate,
          depth,
        }),
      });

      const payload = (await response.json()) as MarketAnalysisResult & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to generate Market Analysis.");
      }

      setMarketAnalysisByCandidate((current) => ({
        ...current,
        [selectedCandidate.id]: payload,
      }));
    } catch (requestError) {
      setMarketAnalysisError(requestError instanceof Error ? requestError.message : "Unexpected market analysis failure.");
    } finally {
      setMarketAnalysisLoading(false);
    }
  }

  async function onGeneratePromoPack() {
    if (!selectedCandidate) {
      setPromoPackError("Select a niche result first.");
      return;
    }

    setPromoPackLoading(true);
    setPromoPackError(null);

    try {
      const response = await fetch("/api/research/promo-pack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          candidate: selectedCandidate,
        }),
      });

      const payload = (await response.json()) as PromoPackResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to generate Promo Pack.");
      }

      setPromoPackByCandidate((current) => ({
        ...current,
        [selectedCandidate.id]: payload,
      }));
    } catch (requestError) {
      setPromoPackError(requestError instanceof Error ? requestError.message : "Unexpected promo pack generation failure.");
    } finally {
      setPromoPackLoading(false);
    }
  }

  async function requestPlan(candidate: NonNullable<typeof selectedCandidate>, type: PlanOutputType) {
    const response = await fetch("/api/research/plan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        candidate,
        type,
      }),
    });

    const payload = (await response.json()) as NichePlanResponse & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? `Failed to generate ${labelForPlanType(type)}.`);
    }

    return payload;
  }

  function exportResearchResults() {
    if (!report) {
      return;
    }

    const envelope: ExportEnvelope = {
      app: APP_ID,
      version: 1,
      exportedAt: new Date().toISOString(),
      report,
    };

    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const baseName = report.queries.length > 1 ? `multi-${report.queries.length}-niches` : report.query || "auto-niche";
    const fileName = `${toSlug(baseName)}-${report.generatedAt.slice(0, 10)}-research.json`;
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function openImportDialog(mode: ImportMode) {
    if (mode === "recovery") {
      recoveryImportFileRef.current?.click();
      return;
    }
    importFileRef.current?.click();
  }

  async function onImportResults(event: ChangeEvent<HTMLInputElement>, mode: ImportMode) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const imported = extractResearchReport(parsed);
      const recoverySnapshot = extractRecoverySnapshot(parsed);

      if (mode === "report" && !imported) {
        setError("Invalid research export file. Expected a Last30Days research payload.");
        return;
      }

      if (mode === "recovery" && !recoverySnapshot) {
        setError("Invalid recovery snapshot file. Expected a saved recovery artifact.");
        return;
      }

      let recoveryImportMessage = "";
      if (recoverySnapshot) {
        const importResponse = await fetch("/api/research/recovery/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resumeKey: recoverySnapshot.checkpointKey,
            checkpoint: recoverySnapshot.checkpoint,
          }),
        });

        if (importResponse.ok) {
          const resumedRun = createRunState(
            recoverySnapshot.checkpoint.niche,
            recoverySnapshot.checkpoint.mode,
            0,
            "recovery",
          );
          const completedSteps = Math.max(
            0,
            Math.min(recoverySnapshot.checkpoint.completedSteps, recoverySnapshot.checkpoint.totalSteps),
          );
          resumedRun.id = recoverySnapshot.checkpointKey;
          resumedRun.niche = recoverySnapshot.checkpoint.niche || "auto-discovery";
          resumedRun.query = recoverySnapshot.checkpoint.niche;
          resumedRun.status = "paused";
          resumedRun.error = recoverySnapshot.recoveryMessages.join(" ").trim() || null;
          resumedRun.progress = {
            stage: "discovering",
            message: "Imported recovery snapshot. Click Resume to continue from checkpoint.",
            elapsedMs: Math.max(0, Date.now() - recoverySnapshot.checkpoint.startedAt),
            etaMs: 0,
            completedSteps,
            totalSteps: recoverySnapshot.checkpoint.totalSteps,
          };
          resumedRun.estimatedTotalSteps = recoverySnapshot.checkpoint.totalSteps;

          setDepth(recoverySnapshot.checkpoint.mode);
          setNicheInput(recoverySnapshot.checkpoint.niche);
          setNicheRuns([resumedRun]);
          setRunStartedAt(recoverySnapshot.checkpoint.startedAt);
          setClockNow(Date.now());
          recoveryImportMessage = ` Resume is available from step ${completedSteps}/${recoverySnapshot.checkpoint.totalSteps}.`;
        } else {
          recoveryImportMessage = " Loaded report view, but checkpoint resume import failed.";
        }
      }

      if (imported) {
        setReport(imported);
      } else if (mode === "recovery") {
        setReport(null);
      }
      setError(null);
      setPlanError(null);
      setMarketAnalysisError(null);
      setPromoPackError(null);
      if (mode === "recovery") {
        setImportNote(
          imported
            ? `Loaded recovery snapshot from ${file.name}.${recoveryImportMessage}`
            : `Loaded checkpoint-only recovery snapshot from ${file.name}.${recoveryImportMessage}`,
        );
      } else {
        setImportNote(`Loaded research from ${file.name}.${recoveryImportMessage}`);
      }
      setPlanResults({});
      setPlanState(EMPTY_PLAN_STATE);
      setMarketAnalysisByCandidate({});
      setPromoPackByCandidate({});
      if (!recoverySnapshot) {
        setNicheRuns([]);
        setLoading(false);
        setRunStartedAt(null);
      }
    } catch {
      setError(
        mode === "recovery"
          ? "Could not import recovery snapshot. Make sure it is valid JSON exported from this app."
          : "Could not import file. Make sure it is valid JSON exported from this app.",
      );
    }
  }

  function copyMarkdown(type: PlanOutputType) {
    const plan = planResults[type];
    if (!plan?.markdown) {
      return;
    }

    void navigator.clipboard.writeText(plan.markdown);
  }

  function downloadMarkdown(type: PlanOutputType) {
    const plan = planResults[type];
    if (!plan || !selectedCandidate) {
      return;
    }

    const blob = new Blob([plan.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${toSlug(selectedCandidate.name)}-${type}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="nv-page">
      <header className="nv-hero">
        <p className="nv-kicker">{APP_NAME}</p>
        <h1>Find buildable AI businesses with proof, not vibes.</h1>
        <p>
          Run trend-first research across the latest 30 days of Reddit, X, and web sources. Generate provable ideas,
          score market fit, create promo packs, and move straight into PRD, Market Plan, and Execution Plan.
        </p>
        <div className="nv-hero-badges">
          <span>3 trend queries per niche</span>
          <span>Reddit + X + Web only</span>
          <span>Proof-backed ideas</span>
          <span>Market Analysis + Promo Pack</span>
        </div>
      </header>

      <div className="nv-shell">
        <section className="nv-card nv-form-card">
          <form onSubmit={onSubmit} className="nv-form">
            <label htmlFor="niche">Niches (optional, comma-separated)</label>
            <textarea
              id="niche"
              value={nicheInput}
              onChange={(event) => setNicheInput(event.target.value)}
              placeholder="Example: dental billing automation, med spa lead follow-up, freight broker dispatch ops"
              rows={5}
            />
            <small className="nv-hint">
              Leave blank to auto-discover. Add multiple niches to run them in parallel.
            </small>

            <div className="nv-suggestion-head">
              <span>Suggested niches</span>
              <div className="nv-inline-actions">
                <button type="button" className="nv-ghost" onClick={() => void regenerateSuggestions()} disabled={suggestionsLoading}>
                  {suggestionsLoading ? "Regenerating..." : "Regen list"}
                </button>
                {inputNiches.length ? (
                  <button type="button" className="nv-ghost" onClick={onGenerateFromNiches} disabled={suggestionsLoading}>
                    Generate based on niches
                  </button>
                ) : null}
              </div>
            </div>

            <div className="nv-example-row">
              {suggestedNiches.map((example) => (
                <button type="button" key={example} className="nv-chip" onClick={() => appendSuggestedNiche(example)}>
                  {example}
                </button>
              ))}
            </div>

            <div className="nv-field-group">
              <span>Research depth</span>
              <div className="nv-depth-grid">
                {(["quick", "default", "deep"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`nv-depth ${depth === value ? "is-active" : ""}`}
                    onClick={() => setDepth(value)}
                  >
                    <strong>{value}</strong>
                    <small>{depthHint(value)}</small>
                  </button>
                ))}
              </div>
              <small className="nv-hint">
                Profile: {depthProfileLabel(depth)} • ~{formatNumber(budgetEstimate.perNicheTokens)} tokens per niche • ~$
                {budgetEstimate.perNicheCostUsd.toFixed(2)} per niche
              </small>
            </div>

            {error ? <p className="nv-error">{error}</p> : null}
            {importNote ? <p className="nv-note">{importNote}</p> : null}

            <div className="nv-estimate">
              <strong>Estimated total research usage</strong>
              <small>
                Trend-first 3-query pipeline estimate based on current depth and niche count.
              </small>
              <small>
                {budgetEstimate.niches} niche{budgetEstimate.niches === 1 ? "" : "s"} •{" "}
                {formatNumber(budgetEstimate.tokens)} tokens (~{formatNumber(budgetEstimate.tokensLow)}-
                {formatNumber(budgetEstimate.tokensHigh)}) • ${budgetEstimate.costUsd.toFixed(2)} (~$
                {budgetEstimate.costLowUsd.toFixed(2)}-${budgetEstimate.costHighUsd.toFixed(2)})
              </small>
            </div>

            <button type="submit" className="nv-submit" disabled={loading}>
              {loading
                ? loadingLabel
                : inputNiches.length > 1
                  ? `Run ${inputNiches.length} Niches In Parallel`
                  : "Run Research"}
            </button>

            <div className="nv-file-actions">
              <button type="button" className="nv-ghost" onClick={() => openImportDialog("report")}>
                Import Results
              </button>
              <button type="button" className="nv-ghost" onClick={() => openImportDialog("recovery")}>
                Import Recovery Snapshot
              </button>
              <button type="button" className="nv-ghost" onClick={exportResearchResults} disabled={!report}>
                Export Results
              </button>
            </div>
            <input
              ref={importFileRef}
              type="file"
              accept="application/json"
              className="nv-hidden-input"
              onChange={(event) => void onImportResults(event, "report")}
            />
            <input
              ref={recoveryImportFileRef}
              type="file"
              accept="application/json"
              className="nv-hidden-input"
              onChange={(event) => void onImportResults(event, "recovery")}
            />
          </form>
        </section>

        <section className="nv-card nv-results-card">
          {runBoardVisible ? (
            <div className="nv-loading">
              {hasActiveRuns ? <div className="nv-spinner" aria-hidden /> : null}
              <h3>{aggregateProgress.message}</h3>
              <p>
                Elapsed <strong>{formatDuration(elapsedMs)}</strong>
                {aggregateProgress.etaMs > 0 ? (
                  <>
                    {" "}
                    • ETA <strong>{formatDuration(aggregateProgress.etaMs)}</strong>
                  </>
                ) : null}
              </p>
              <div className="nv-progress-track" aria-hidden>
                <div
                  className="nv-progress-fill"
                  style={{ width: `${Math.max(0, Math.min(100, aggregateProgress.percent))}%` }}
                />
              </div>
              <small>
                {aggregateProgress.completedSteps}/{aggregateProgress.totalSteps} estimated steps •{" "}
                {aggregateProgress.complete}/{nicheRuns.length} runs complete
                {aggregateProgress.paused ? ` • ${aggregateProgress.paused} paused` : ""}
                {aggregateProgress.failed ? ` • ${aggregateProgress.failed} stopped/failed` : ""}
              </small>

              <div className="nv-niche-progress-grid">
                {nicheRuns.map((run) => {
                  const completedSteps = run.progress?.completedSteps ?? (run.status === "completed" ? run.estimatedTotalSteps : 0);
                  const totalSteps = run.progress?.totalSteps ?? run.estimatedTotalSteps;
                  const percent = totalSteps ? Math.round((completedSteps / totalSteps) * 100) : 0;
                  const failureReason =
                    run.status === "failed" || run.status === "stopped"
                      ? getRunFailureReason(run)
                      : null;
                  const message =
                    (run.status === "failed" || run.status === "stopped"
                      ? failureReason
                      : run.progress?.message) ||
                    (run.status === "paused"
                      ? "Paused by user."
                      : run.status === "stopped"
                        ? "Stopped by user."
                        : run.status === "completed"
                          ? "Niche validation complete."
                          : run.status === "failed"
                            ? "Niche validation failed."
                            : run.status === "queued"
                              ? "Queued and waiting for worker."
                              : "Running research...");

                  return (
                    <article key={run.id} className={`nv-niche-progress is-${run.status}`}>
                      <header>
                        <strong>{run.niche}</strong>
                        <span>{statusLabel(run.status)}</span>
                      </header>
                      <p>{message}</p>
                      <div className="nv-progress-track" aria-hidden>
                        <div className="nv-progress-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
                      </div>
                      <small>
                        {completedSteps}/{totalSteps} steps
                        {run.status === "running" && run.progress?.etaMs ? ` • ETA ${formatDuration(run.progress.etaMs)}` : ""}
                      </small>
                      {failureReason ? <p className="nv-failure-reason">Reason: {failureReason}</p> : null}
                      {failureReason ? (
                        <ul className="nv-failure-guidance">
                          {failureSuggestions(failureReason, run.niche).map((tip) => (
                            <li key={`${run.id}-${tip}`}>{tip}</li>
                          ))}
                        </ul>
                      ) : null}
                      {run.status === "running" || run.status === "paused" || run.status === "queued" ? (
                        <div className="nv-niche-actions">
                          <button
                            type="button"
                            className="nv-ghost"
                            onClick={() => pauseNiche(run.id)}
                            disabled={run.status !== "running"}
                          >
                            Pause
                          </button>
                          <button
                            type="button"
                            className="nv-ghost nv-ghost-strong"
                            onClick={() => resumeNiche(run.id)}
                            disabled={run.status !== "paused"}
                          >
                            Resume
                          </button>
                          <button
                            type="button"
                            className="nv-ghost nv-ghost-danger"
                            onClick={() => stopNiche(run.id)}
                            disabled={run.status !== "running" && run.status !== "paused" && run.status !== "queued"}
                          >
                            Stop
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}

          {runSummaryVisible ? (
            <div className="nv-run-summary">
              <h3>Research finished.</h3>
              <div className="nv-run-strip">
                {nicheRuns.map((run) => (
                  <div key={run.id} className={`nv-run-pill ${run.status === "completed" ? "" : "is-failed"}`}>
                    <strong>{run.niche}</strong>
                    <span>
                      {run.status === "completed"
                        ? `${run.report?.candidates.length ?? 0} ideas${run.error ? " • partial recovery" : ""}`
                        : getRunFailureReason(run)}
                    </span>
                    {run.status === "completed" && run.error ? (
                      <small className="nv-run-warning">{run.error}</small>
                    ) : null}
                    {run.status !== "completed" ? (
                      <ul className="nv-failure-guidance">
                        {failureSuggestions(getRunFailureReason(run), run.niche).map((tip) => (
                          <li key={`${run.id}-${tip}`}>{tip}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {!report && !loading && !runBoardVisible && !runSummaryVisible ? (
            <div className="nv-empty">
              <h2>Ready to validate.</h2>
              <p>
                Run a search to identify niches with buyer spend, recurring pain, and launch room. Multi-niche runs are
                processed in parallel.
              </p>
            </div>
          ) : null}

          {report ? (
            <>
              <div className="nv-summary-bar">
                <StatTile label="Candidates" value={report.stats.total} />
                <StatTile label="Niche runs" value={`${report.stats.runsCompleted}/${report.stats.runsTotal}`} />
                <StatTile label="Mode" value={report.mode} />
                <StatTile label="Sources" value="Reddit + X + Web" />
                <StatTile label="Runtime" value={formatDuration(report.stats.elapsedMs)} />
              </div>

              <div className="nv-summary-meta">
                <span>{report.discoveryMode ? "Auto-discovery mode" : `Focused niches: ${report.queries.join(", ")}`}</span>
                <span>
                  Window: {report.range.from} to {report.range.to}
                </span>
                <span>Generated {new Date(report.generatedAt).toLocaleString()}</span>
              </div>

              <div className="nv-usage-strip">
                <span>
                  Tokens used: <strong>{formatNumber(report.usage.totalTokens)}</strong>
                </span>
                <span>
                  Cost: <strong>${report.usage.costUsd.toFixed(6)}</strong>
                </span>
                <span>
                  Model calls: <strong>{report.usage.calls}</strong>
                </span>
              </div>

              <div className="nv-run-strip">
                {report.runs.map((run) => (
                  <div key={run.niche} className={`nv-run-pill ${run.status === "failed" ? "is-failed" : ""}`}>
                    <strong>{run.niche}</strong>
                    <span>
                      {run.status === "completed"
                        ? `${run.candidateCount} ideas${run.error ? " • partial recovery" : ""}`
                        : run.error || "failed"}
                    </span>
                    {run.status === "completed" && run.error ? (
                      <small className="nv-run-warning">{run.error}</small>
                    ) : null}
                  </div>
                ))}
              </div>

              {visibleCandidates.length ? (
                <p className="nv-pass-note">Showing vetted and provable ideas with full dossier output for each niche.</p>
              ) : (
                <p className="nv-pass-note is-warning">
                  No niches passed all checks in this run. Try a deeper search or refine your niche input.
                </p>
              )}

              {visibleCandidates.length ? (
                <div className="nv-candidate-grid">
                  {visibleCandidates.map((candidate) => {
                    const selected = selectedCandidate?.id === candidate.id;
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        className={`nv-candidate ${selected ? "is-selected" : ""}`}
                        onClick={() => setSelectedId(candidate.id)}
                      >
                        <header>
                          <h3>{candidate.name}</h3>
                          <span className={`nv-verdict verdict-${candidate.verdict}`}>{candidate.verdict}</span>
                        </header>
                        <p>{candidate.oneLiner || candidate.aiBuildAngle}</p>
                        <div className="nv-check-row">
                          <CheckPill label="Spending" pass={candidate.checks.spending.passed} />
                          <CheckPill label="Pain" pass={candidate.checks.pain.passed} />
                          <CheckPill label="Room" pass={candidate.checks.room.passed} />
                        </div>
                        <small>
                          Score {candidate.score}/100
                          {candidate.requestedNiche ? ` • from ${candidate.requestedNiche}` : ""}
                        </small>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="nv-empty nv-empty-result">
                  <h2>No validated niches found.</h2>
                  <p>Results are strict: each niche must pass spending, pain, and room with evidence.</p>
                </div>
              )}

              {selectedCandidate ? (
                <article className="nv-detail">
                  <header>
                    <h2>{selectedCandidate.name}</h2>
                  </header>

                  <p className="nv-lead">{selectedCandidate.problemStatement}</p>
                  <p className="nv-meta">
                    ICP: {selectedCandidate.icp || selectedCandidate.audience || "n/a"}
                    {selectedCandidate.requestedNiche ? ` • Requested niche: ${selectedCandidate.requestedNiche}` : ""}
                  </p>

                  <div className="nv-detail-grid nv-dossier-grid">
                    <DataBlock title="Demand Snapshot" lines={[
                      selectedCandidate.demand.trendSummary,
                      ...selectedCandidate.demand.urgencyDrivers,
                      ...selectedCandidate.demand.buyingSignals,
                    ]} />
                    <DataBlock
                      title="Market Landscape"
                      lines={[
                        `Competition: ${selectedCandidate.landscape.competitionLevel}`,
                        `Wedge: ${selectedCandidate.landscape.beachheadWedge}`,
                        ...selectedCandidate.landscape.whitespace,
                      ]}
                    />
                    <DataBlock
                      title="Business Model"
                      lines={[
                        selectedCandidate.businessModel.pricingModel,
                        `Price anchor: ${selectedCandidate.businessModel.priceAnchor}`,
                        `Time to first dollar: ${selectedCandidate.businessModel.timeToFirstDollar}`,
                        `Gross margin profile: ${selectedCandidate.businessModel.expectedGrossMargin}`,
                      ]}
                    />
                    <DataBlock
                      title="Go-To-Market"
                      lines={[
                        selectedCandidate.goToMarket.offerHook,
                        selectedCandidate.goToMarket.salesMotion,
                        selectedCandidate.goToMarket.retentionLoop,
                        ...selectedCandidate.goToMarket.channels,
                      ]}
                    />
                    <DataBlock
                      title="Execution Blueprint"
                      lines={[
                        `Complexity: ${selectedCandidate.execution.buildComplexity}`,
                        selectedCandidate.execution.stackRecommendation,
                        ...selectedCandidate.execution.mvpScope,
                        ...selectedCandidate.execution.automationLevers,
                        ...selectedCandidate.execution.moatLevers,
                      ]}
                    />
                    <DataBlock
                      title="Outcome Ranking"
                      lines={[
                        `Time to first dollar: ${selectedCandidate.outcomes.timeToFirstDollarDays} days`,
                        `GTM difficulty: ${selectedCandidate.outcomes.gtmDifficulty}/10`,
                        `Integration complexity: ${selectedCandidate.outcomes.integrationComplexity}/10`,
                        `Outcome score: ${selectedCandidate.outcomes.weightedScore}/100`,
                      ]}
                    />
                    <DataBlock
                      title="Competitor Snapshot"
                      lines={selectedCandidate.competitors.map(
                        (item) =>
                          `${item.name} (${item.confidence}): ${item.pricingSummary} | friction: ${item.onboardingFriction} | sentiment: ${item.reviewSentiment}`,
                      )}
                    />
                    <DataBlock
                      title="Persona Variants"
                      lines={selectedCandidate.personaVariants.map(
                        (persona) =>
                          `${persona.persona}: ${persona.offerVariant} (${persona.pricingAngle}) via ${persona.bestChannel}`,
                      )}
                    />
                  </div>

                  <div className="nv-claim-grid">
                    <ClaimBlock title="Spending Claims" claims={selectedCandidate.checks.spending.claims} />
                    <ClaimBlock title="Pain Claims" claims={selectedCandidate.checks.pain.claims} />
                    <ClaimBlock title="Room Claims" claims={selectedCandidate.checks.room.claims} />
                  </div>

                  {selectedCandidate.proofPoints.length ? (
                    <section className="nv-news-block">
                      <h4>Provable Evidence</h4>
                      <ul>
                        {selectedCandidate.proofPoints.map((item, index) => (
                          <li key={`${item.sourceUrl}-${index}`}>
                            <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                              {item.claim}
                            </a>
                            <span>
                              {item.sourceType}
                              {item.date ? ` • ${item.date}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {selectedTrendSynthesis ? (
                    <section className="nv-news-block">
                      <h4>Trend Synthesis</h4>
                      <p>{selectedTrendSynthesis.summary}</p>
                      <ul>
                        {selectedTrendSynthesis.keyTrends.slice(0, 6).map((item) => (
                          <li key={`trend-${item}`}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {selectedTrendNews.length ? (
                    <section className="nv-news-block">
                      <h4>Latest Trend/News</h4>
                      <ul>
                        {selectedTrendNews.map((item) => (
                          <li key={`${item.url}-${item.title}`}>
                            <a href={item.url} target="_blank" rel="noreferrer">
                              {item.title}
                            </a>
                            <span>
                              {item.date ? `${item.date} • ` : ""}
                              {item.confidence} confidence
                            </span>
                            <p>{item.summary || item.whyItMatters}</p>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {selectedCandidate.demand.searchKeywords.length ? (
                    <div className="nv-tags">
                      {selectedCandidate.demand.searchKeywords.map((keyword) => (
                        <span key={keyword}>{keyword}</span>
                      ))}
                    </div>
                  ) : null}

                  {selectedCandidate.validationPlan.length ? (
                    <section className="nv-validation-plan">
                      <h4>Validation Experiments</h4>
                      <ul>
                        {selectedCandidate.validationPlan.map((step, index) => (
                          <li key={`${step.experiment}-${index}`}>
                            <strong>{step.experiment}</strong>
                            <span>{step.successMetric}</span>
                            <em>{step.effort} effort</em>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {selectedCandidate.risks.length ? (
                    <section className="nv-risk-block">
                      <h4>Key Risks</h4>
                      <ul>
                        {selectedCandidate.risks.map((risk) => (
                          <li key={risk}>{risk}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {selectedCandidate.killCriteria.length ? (
                    <section className="nv-risk-block">
                      <h4>Kill Criteria</h4>
                      <ul>
                        {selectedCandidate.killCriteria.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  <div className="nv-source-list">
                    {selectedCandidate.sources.slice(0, 12).map((source) => (
                      <a key={`${source.url}-${source.title}`} href={source.url} target="_blank" rel="noreferrer">
                        <span>{source.type}</span>
                        {source.title}
                      </a>
                    ))}
                  </div>

                  <div className="nv-action-stack">
                    <div className="nv-inline-actions">
                      <button
                        type="button"
                        className="nv-ghost"
                        onClick={onRunMarketAnalysis}
                        disabled={marketAnalysisLoading}
                      >
                        {marketAnalysisLoading ? "Running Market Analysis..." : "Market Analysis"}
                      </button>
                      <button
                        type="button"
                        className="nv-ghost"
                        onClick={onGeneratePromoPack}
                        disabled={promoPackLoading}
                      >
                        {promoPackLoading ? "Generating Promo Pack..." : "Promo Pack"}
                      </button>
                    </div>
                    <button type="button" className="nv-submit" onClick={onGenerateOutputs} disabled={planning}>
                      {planning ? "Generating outputs..." : "Proceed: Generate PRD + Market Plan + Execution Plan"}
                    </button>
                  </div>

                  {selectedMarketAnalysis ? (
                    <p className="nv-note">
                      Market fit score: <strong>{selectedMarketAnalysis.overallScore}/100</strong> ({selectedMarketAnalysis.verdict}). You
                      can still generate all build outputs regardless of score.
                    </p>
                  ) : null}

                  {marketAnalysisError ? <p className="nv-error">{marketAnalysisError}</p> : null}
                  {promoPackError ? <p className="nv-error">{promoPackError}</p> : null}

                  {selectedMarketAnalysis ? (
                    <section className="nv-news-block">
                      <h4>
                        Market Analysis: {selectedMarketAnalysis.overallScore}/100 ({selectedMarketAnalysis.verdict})
                      </h4>
                      <ul className="nv-score-grid">
                        <li>Demand: {selectedMarketAnalysis.subscores.demand}/100</li>
                        <li>Urgency: {selectedMarketAnalysis.subscores.urgency}/100</li>
                        <li>Accessibility: {selectedMarketAnalysis.subscores.accessibility}/100</li>
                        <li>Monetization: {selectedMarketAnalysis.subscores.monetization}/100</li>
                        <li>Competition Headroom: {selectedMarketAnalysis.subscores.competitionHeadroom}/100</li>
                      </ul>
                      {selectedMarketAnalysis.rationale.length ? (
                        <ul>
                          {selectedMarketAnalysis.rationale.slice(0, 8).map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  ) : null}

                  {selectedPromoPack ? (
                    <article className="nv-markdown">
                      <header>
                        <h2>Promo Pack</h2>
                        <div>
                          <button type="button" className="nv-ghost" onClick={() => void navigator.clipboard.writeText(selectedPromoPack.markdown)}>
                            Copy Markdown
                          </button>
                        </div>
                      </header>
                      <p className="nv-meta">
                        Generated {new Date(selectedPromoPack.generatedAt).toLocaleString()} •{" "}
                        {formatNumber(selectedPromoPack.usage.totalTokens)} tokens • $
                        {selectedPromoPack.usage.costUsd.toFixed(6)}
                      </p>
                      <pre>{selectedPromoPack.markdown}</pre>
                    </article>
                  ) : null}

                  {planState.stage === "running" ? (
                    <div className="nv-plan-status">
                      <h4>{planState.message}</h4>
                      <p>
                        Elapsed <strong>{formatDuration(planElapsedMs)}</strong>
                        {planState.etaTargetAt ? (
                          <>
                            {" "}
                            • ETA <strong>{formatDuration(planRemainingMs)}</strong>
                          </>
                        ) : null}
                      </p>
                      <div className="nv-progress-track" aria-hidden>
                        <div
                          className="nv-progress-fill"
                          style={{ width: `${Math.max(0, Math.min(100, planProgressPercent))}%` }}
                        />
                      </div>
                      <small>
                        {planState.completed}/{planState.total} outputs completed
                      </small>
                    </div>
                  ) : null}

                  {planState.stage === "complete" ? <p className="nv-note">{planState.message}</p> : null}
                  {planError ? <p className="nv-error">{planError}</p> : null}
                </article>
              ) : null}

              <div className="nv-output-grid">
                {PLAN_SEQUENCE.map((type) => {
                  const plan = planResults[type];
                  if (!plan) {
                    return null;
                  }

                  return (
                    <article key={type} className="nv-markdown">
                      <header>
                        <h2>{labelForPlanType(type)}</h2>
                        <div>
                          <button type="button" className="nv-ghost" onClick={() => copyMarkdown(type)}>
                            Copy Markdown
                          </button>
                          <button type="button" className="nv-ghost" onClick={() => downloadMarkdown(type)}>
                            Export .md
                          </button>
                        </div>
                      </header>
                      <p className="nv-meta">
                        Generated {new Date(plan.generatedAt).toLocaleString()} • {formatNumber(plan.usage.totalTokens)} tokens
                        • ${plan.usage.costUsd.toFixed(6)}
                      </p>
                      <pre>{plan.markdown}</pre>
                    </article>
                  );
                })}
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function extractResearchReport(value: unknown): NicheResearchResponse | null {
  const candidate =
    value && typeof value === "object" && "report" in value
      ? (value as { report?: unknown }).report
      : value;

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const typed = candidate as Partial<NicheResearchResponse>;
  if (!typed.stats || !typed.range || !typed.usage || !Array.isArray(typed.candidates)) {
    return null;
  }

  if (typeof typed.mode !== "string" || typeof typed.generatedAt !== "string") {
    return null;
  }

  const safeQueries = Array.isArray(typed.queries)
    ? typed.queries.filter((item): item is string => typeof item === "string")
    : typeof typed.query === "string" && typed.query
      ? [typed.query]
      : [];

  const runs = Array.isArray(typed.runs)
    ? typed.runs
    : [
        {
          niche: typed.query || "imported",
          status: "completed" as const,
          candidateCount: typed.candidates.length,
          elapsedMs: typed.stats.elapsedMs,
        },
      ];

  return {
    ...(typed as NicheResearchResponse),
    query: typeof typed.query === "string" ? typed.query : safeQueries.join(", "),
    queries: safeQueries,
    candidates: typed.candidates.map((entry, index) =>
      normalizeImportedCandidate(entry as NicheResearchResponse["candidates"][number], index),
    ),
    runs,
    stats: {
      ...typed.stats,
      runsCompleted:
        typeof typed.stats.runsCompleted === "number" ? typed.stats.runsCompleted : runs.filter((run) => run.status === "completed").length,
      runsTotal: typeof typed.stats.runsTotal === "number" ? typed.stats.runsTotal : runs.length,
    },
  };
}

function extractRecoverySnapshot(value: unknown): ImportedRecoverySnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const envelope = value as RecoveryArtifactEnvelope;
  if (envelope.kind !== "recovery-artifact") {
    return null;
  }

  const checkpoint = envelope.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") {
    return null;
  }

  const typed = checkpoint as Partial<ImportedRecoveryCheckpoint>;
  const checkpointKey = typeof envelope.checkpointKey === "string" ? envelope.checkpointKey.trim() : "";
  if (
    !checkpointKey ||
    typed.version !== 1 ||
    typeof typed.niche !== "string" ||
    (typed.mode !== "quick" && typed.mode !== "default" && typed.mode !== "deep") ||
    typeof typed.startedAt !== "number" ||
    typeof typed.totalSteps !== "number" ||
    typeof typed.completedSteps !== "number" ||
    !Array.isArray(typed.queries) ||
    !typed.usageTotals ||
    !typed.allRaw
  ) {
    return null;
  }

  const recoveryMessages = Array.isArray(envelope.recoveryMessages)
    ? envelope.recoveryMessages
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];

  return {
    checkpointKey,
    checkpoint: typed as ImportedRecoveryCheckpoint,
    recoveryMessages,
  };
}

function parseCommaNiches(value: string) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function estimateBudget(nicheCount: number, depth: NicheResearchDepth): BudgetEstimate {
  const perNiche = depth === "quick"
    ? { tokens: 160000, costUsd: 1.85 }
    : depth === "deep"
      ? { tokens: 460000, costUsd: 5.35 }
      : { tokens: 290000, costUsd: 3.35 };

  const tokens = Math.round(perNiche.tokens * nicheCount);
  const costUsd = perNiche.costUsd * nicheCount;
  const lowMultiplier = 0.72;
  const highMultiplier = 1.32;

  return {
    niches: nicheCount,
    perNicheTokens: perNiche.tokens,
    perNicheCostUsd: perNiche.costUsd,
    tokens,
    tokensLow: Math.round(tokens * lowMultiplier),
    tokensHigh: Math.round(tokens * highMultiplier),
    costUsd,
    costLowUsd: costUsd * lowMultiplier,
    costHighUsd: costUsd * highMultiplier,
  };
}

function estimateStepsForNiche() {
  return 7;
}

function createRunState(niche: string, depth: NicheResearchDepth, index: number, batchId: string): NicheRunState {
  const cleaned = niche.trim();
  const display = cleaned || "auto-discovery";
  return {
    id: `${toSlug(display)}-${batchId}-${index + 1}`,
    niche: display,
    query: cleaned,
    status: "queued",
    progress: null,
    report: null,
    error: null,
    estimatedTotalSteps: estimateStepsForNiche(),
  };
}

function combineReportsFromRuns(
  completedReports: NicheResearchResponse[],
  runStates: NicheRunState[],
  depth: NicheResearchDepth,
): NicheResearchResponse {
  const allCandidates: NicheResearchResponse["candidates"] = [];
  const seen = new Set<string>();

  for (const report of completedReports) {
    for (const candidate of report.candidates) {
      const keyByName = `${candidate.requestedNiche ?? report.query}|${candidate.name.toLowerCase().trim()}`;
      const keyBySimilarity = toCandidateSimilarityKey(candidate, report.query);
      if (seen.has(keyByName) || seen.has(keyBySimilarity)) {
        continue;
      }
      seen.add(keyByName);
      seen.add(keyBySimilarity);
      allCandidates.push({
        ...candidate,
        id: `${candidate.id}-${toSlug(candidate.requestedNiche || report.query || "candidate")}-${allCandidates.length + 1}`,
      });
    }
  }

  const usage = completedReports.reduce<TokenUsageSummary>(
    (acc, report) => ({
      inputTokens: acc.inputTokens + report.usage.inputTokens,
      outputTokens: acc.outputTokens + report.usage.outputTokens,
      totalTokens: acc.totalTokens + report.usage.totalTokens,
      costUsd: acc.costUsd + report.usage.costUsd,
      calls: acc.calls + report.usage.calls,
      model: acc.model ?? report.usage.model,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      calls: 0,
    },
  );

  const runs: NicheResearchResponse["runs"] = runStates.map((run) => {
    if (run.status === "completed" && run.report) {
      return {
        niche: run.niche,
        status: "completed" as const,
        candidateCount: run.report.candidates.length,
        elapsedMs: run.report.stats.elapsedMs,
        trendNews: run.report.runs[0]?.trendNews ?? [],
        trendSynthesis: run.report.runs[0]?.trendSynthesis ?? null,
      };
    }

    return {
      niche: run.niche,
      status: "failed" as const,
      candidateCount: 0,
      elapsedMs: run.progress?.elapsedMs ?? 0,
      error: run.error || (run.status === "paused" ? "Paused by user" : "Stopped before completion"),
    };
  });

  const queries = runStates.map((run) => run.query).filter(Boolean);
  const range = completedReports[0]?.range ?? { from: "", to: "" };

  return {
    query: queries.join(", "),
    queries,
    discoveryMode: runStates.length === 1 && !queries.length,
    mode: depth,
    range,
    generatedAt: new Date().toISOString(),
    candidates: allCandidates,
    runs,
    stats: {
      total: allCandidates.length,
      passed: allCandidates.length,
      elapsedMs: Math.max(0, ...runStates.map((run) => run.progress?.elapsedMs ?? 0)),
      runsCompleted: runs.filter((run) => run.status === "completed").length,
      runsTotal: runs.length,
    },
    usage,
  };
}

function depthHint(depth: NicheResearchDepth) {
  if (depth === "quick") {
    return "Fastest";
  }

  if (depth === "deep") {
    return "Most complete";
  }

  return "Balanced";
}

function depthProfileLabel(depth: NicheResearchDepth) {
  if (depth === "quick") {
    return "Lean signal pass";
  }

  if (depth === "deep") {
    return "Most complete dossier pass";
  }

  return "Balanced validation pass";
}

function estimatePlanDurationForSequence(sequence: PlanOutputType[]) {
  return sequence.reduce((total, type) => total + estimatePlanDuration(type), 0);
}

function estimatePlanDuration(type: PlanOutputType) {
  if (type === "prd") {
    return ESTIMATED_PRD_MS;
  }
  if (type === "market") {
    return ESTIMATED_MARKET_MS;
  }
  return ESTIMATED_PLAN_MS;
}

function labelForPlanType(type: PlanOutputType) {
  if (type === "prd") {
    return "PRD";
  }
  if (type === "market") {
    return "Market Plan";
  }
  return "Execution Plan";
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US");
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function statusLabel(state: NicheRunStatus) {
  if (state === "completed") {
    return "done";
  }

  if (state === "failed") {
    return "failed";
  }

  if (state === "paused") {
    return "paused";
  }

  if (state === "stopped") {
    return "stopped";
  }

  if (state === "running") {
    return "running";
  }

  return "queued";
}

function getRunFailureReason(run: NicheRunState) {
  if (run.error?.trim()) {
    return run.error.trim();
  }

  if (run.progress?.message?.trim()) {
    return run.progress.message.trim();
  }

  if (run.status === "stopped") {
    return "Stopped by user.";
  }

  return "No failure reason was returned.";
}

function toFailedRunState(run: NicheRunState, error: string): NicheRunState {
  const message = error.trim() || "Niche validation failed.";
  return {
    ...run,
    status: "failed",
    error: message,
    progress: {
      stage: "complete",
      message,
      elapsedMs: run.progress?.elapsedMs ?? 0,
      etaMs: 0,
      completedSteps: run.progress?.completedSteps ?? 0,
      totalSteps: run.progress?.totalSteps ?? run.estimatedTotalSteps,
    },
  };
}

function failureSuggestions(error: string | null, niche: string) {
  const source = (error || "").toLowerCase();

  if (source.includes("timed out")) {
    return [
      "Try `Quick` depth first, then rerun this niche in `Default`.",
      `Narrow the niche from "${niche}" to a specific workflow or audience.`,
      "Run this niche alone to reduce parallel load and timeout risk.",
    ];
  }

  if (source.includes("aborted")) {
    return [
      "Retry this niche once; this is usually a transient timeout/transport issue.",
      "Use `Quick` depth first, then rerun winners in `Default` or `Deep`.",
      "If repeated, run fewer niches in parallel to reduce provider pressure.",
    ];
  }

  if (source.includes("api key") || source.includes("openrouter")) {
    return [
      "Verify OpenRouter keys/models in `.env`.",
      "Retry after a minute if provider capacity is temporarily constrained.",
      "Switch to a lighter depth to reduce token demand.",
    ];
  }

  if (source.includes("rate")) {
    return [
      "Retry with fewer niches in parallel.",
      "Use `Quick` depth for the first pass, then deepen winners.",
      "Rerun after short cooldown to avoid provider throttling.",
    ];
  }

  return [
    `Make "${niche}" more specific (audience + job-to-be-done + tool context).`,
    "Retry once in `Quick` depth to validate retrieval quality.",
    "If still failing, run this niche by itself and compare errors.",
  ];
}

function toSlug(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "niche-validator-output";
}

function toCandidateSimilarityKey(candidate: NicheResearchResponse["candidates"][number], fallbackQuery: string) {
  const scope = candidate.requestedNiche || fallbackQuery || "global";
  const problem = (candidate.problemStatement || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const proofUrls = (candidate.proofPoints || [])
    .map((point) => point.sourceUrl.toLowerCase().replace(/\/$/, ""))
    .sort()
    .slice(0, 3)
    .join("|");
  return `${scope}|${problem}|${proofUrls}`;
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="nv-stat-tile">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function CheckPill({ label, pass }: { label: string; pass: boolean }) {
  return <span className={`nv-check-pill ${pass ? "is-pass" : "is-fail"}`}>{label}</span>;
}

function DataBlock({ title, lines }: { title: string; lines: string[] }) {
  const compact = lines.map((line) => line.trim()).filter(Boolean).slice(0, 8);

  return (
    <section className="nv-check-block">
      <h4>{title}</h4>
      {compact.length ? (
        <ul>
          {compact.map((line, index) => (
            <li key={`${title}-${index}`}>{line}</li>
          ))}
        </ul>
      ) : (
        <p>No signal captured.</p>
      )}
    </section>
  );
}

function ClaimBlock({
  title,
  claims,
}: {
  title: string;
  claims: Array<{ claim: string; confidence: "high" | "med" | "low"; sourceUrl?: string }>;
}) {
  return (
    <section className="nv-check-block">
      <h4>{title}</h4>
      {claims.length ? (
        <ul className="nv-claim-list">
          {claims.map((item, index) => (
            <li key={`${title}-${index}`}>
              <span className={`nv-confidence confidence-${item.confidence}`}>{item.confidence}</span>
              {item.claim}
            </li>
          ))}
        </ul>
      ) : (
        <p>No confidence-scored claims yet.</p>
      )}
    </section>
  );
}

function normalizeImportedCandidate(candidate: NicheResearchResponse["candidates"][number], index: number) {
  return {
    ...candidate,
    id: candidate.id || `candidate-${index + 1}`,
    problemStatement:
      candidate.problemStatement || candidate.oneLiner || candidate.aiBuildAngle || "Recurring workflow pain with paid demand.",
    icp: candidate.icp || candidate.audience || "Operators with recurring pain",
    demand: {
      trendSummary: candidate.demand?.trendSummary || "Demand signal exists and should be validated in customer calls.",
      urgencyDrivers: candidate.demand?.urgencyDrivers || [],
      buyingSignals: candidate.demand?.buyingSignals || [],
      searchKeywords: candidate.demand?.searchKeywords || [],
    },
    landscape: {
      competitionLevel: candidate.landscape?.competitionLevel || "medium",
      incumbentTypes: candidate.landscape?.incumbentTypes || [],
      whitespace: candidate.landscape?.whitespace || [],
      beachheadWedge: candidate.landscape?.beachheadWedge || "Faster setup and measurable ROI",
    },
    businessModel: {
      pricingModel: candidate.businessModel?.pricingModel || "SaaS subscription",
      priceAnchor: candidate.businessModel?.priceAnchor || "$49-$299/mo",
      timeToFirstDollar: candidate.businessModel?.timeToFirstDollar || "2-6 weeks",
      expectedGrossMargin: candidate.businessModel?.expectedGrossMargin || "70%+",
    },
    goToMarket: {
      channels: candidate.goToMarket?.channels || [],
      offerHook: candidate.goToMarket?.offerHook || "Automate painful recurring work quickly",
      salesMotion: candidate.goToMarket?.salesMotion || "Founder-led outbound and community GTM",
      retentionLoop: candidate.goToMarket?.retentionLoop || "ROI and outcomes reporting",
    },
    execution: {
      buildComplexity: candidate.execution?.buildComplexity || "medium",
      stackRecommendation: candidate.execution?.stackRecommendation || "Next.js + workflow automation + LLM APIs",
      mvpScope: candidate.execution?.mvpScope || [],
      automationLevers: candidate.execution?.automationLevers || [],
      moatLevers: candidate.execution?.moatLevers || [],
    },
    outcomes: {
      timeToFirstDollarDays: candidate.outcomes?.timeToFirstDollarDays ?? 60,
      gtmDifficulty: candidate.outcomes?.gtmDifficulty ?? 5,
      integrationComplexity: candidate.outcomes?.integrationComplexity ?? 5,
      weightedScore: candidate.outcomes?.weightedScore ?? 50,
    },
    competitors: (candidate.competitors || []).map((entry) => ({
      ...entry,
      confidence: entry.confidence || "med",
    })),
    personaVariants: candidate.personaVariants || [],
    validationPlan: candidate.validationPlan || [],
    risks: candidate.risks || [],
    killCriteria: candidate.killCriteria || [],
    proofPoints: candidate.proofPoints || [],
    checks: {
      ...candidate.checks,
      spending: {
        ...candidate.checks.spending,
        claims: candidate.checks.spending?.claims || [],
      },
      pain: {
        ...candidate.checks.pain,
        claims: candidate.checks.pain?.claims || [],
      },
      room: {
        ...candidate.checks.room,
        claims: candidate.checks.room?.claims || [],
      },
    },
  };
}
