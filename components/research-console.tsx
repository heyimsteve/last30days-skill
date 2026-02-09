"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { NichePlanResponse, NicheResearchDepth, NicheResearchProgressEvent, NicheResearchResponse, PlanOutputType } from "@/lib/niche-types";

const EXAMPLE_NICHES = [
  "Dental insurance claim denials",
  "Shopify refund abuse detection",
  "Home services quote follow-up",
  "YouTube creator sponsorship ops",
];

const PLAN_SEQUENCE: PlanOutputType[] = ["prd", "plan"];
const ESTIMATED_PRD_MS = 105000;
const ESTIMATED_PLAN_MS = 105000;

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
  app: "niche-validator-studio";
  version: 1;
  exportedAt: string;
  report: NicheResearchResponse;
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
  const [niche, setNiche] = useState("");
  const [depth, setDepth] = useState<NicheResearchDepth>("default");

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<NicheResearchProgressEvent | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [etaTargetAt, setEtaTargetAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());

  const [report, setReport] = useState<NicheResearchResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");

  const [planning, setPlanning] = useState(false);
  const [planResults, setPlanResults] = useState<Partial<Record<PlanOutputType, NichePlanResponse>>>({});
  const [planState, setPlanState] = useState<PlanGenerationState>(EMPTY_PLAN_STATE);

  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);

  const importFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading && !planning) {
      return;
    }

    const timer = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading, planning]);

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
  const remainingMs = etaTargetAt ? Math.max(0, etaTargetAt - clockNow) : 0;
  const progressPercent = progress ? Math.round((progress.completedSteps / progress.totalSteps) * 100) : 0;

  const planElapsedMs = planState.startedAt ? Math.max(0, clockNow - planState.startedAt) : 0;
  const planRemainingMs = planState.etaTargetAt ? Math.max(0, planState.etaTargetAt - clockNow) : 0;
  const planProgressPercent = planState.total
    ? Math.round((planState.completed / planState.total) * 100)
    : 0;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setLoading(true);
    setError(null);
    setPlanError(null);
    setImportNote(null);
    setPlanResults({});
    setPlanState(EMPTY_PLAN_STATE);
    setReport(null);
    setProgress(null);
    setRunStartedAt(Date.now());
    setEtaTargetAt(null);
    setClockNow(Date.now());

    try {
      const response = await fetch("/api/research/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          niche: niche.trim(),
          depth,
        }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as { error?: string };
          setError(payload.error ?? "Niche validation request failed.");
        } else {
          setError("Niche validation request failed.");
        }
        return;
      }

      const body = response.body;
      if (!body) {
        setError("No stream received from niche validator endpoint.");
        return;
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotResult = false;
      let gotError = false;

      while (true) {
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
            setProgress(payload.progress);
            setEtaTargetAt(Date.now() + payload.progress.etaMs);
            continue;
          }

          if (payload.type === "result" && payload.report) {
            gotResult = true;
            setReport(payload.report);
            continue;
          }

          if (payload.type === "error") {
            gotError = true;
            setError(payload.error ?? "Niche validation failed.");
          }
        }
      }

      if (!gotResult && !gotError) {
        setError("Validation stream ended before a final result was returned.");
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Unexpected request failure.";
      setError(message);
    } finally {
      setLoading(false);
      setEtaTargetAt(null);
    }
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
      message: "Generating PRD...",
      completed: 0,
      total: PLAN_SEQUENCE.length,
      startedAt,
      etaTargetAt: startedAt + ESTIMATED_PRD_MS + ESTIMATED_PLAN_MS,
    });

    let prdResult: NichePlanResponse | null = null;

    try {
      prdResult = await requestPlan(selectedCandidate, "prd");
      setPlanResults({ prd: prdResult });

      const secondStepStart = Date.now();
      setPlanState({
        stage: "running",
        message: "PRD complete. Generating Execution Plan...",
        completed: 1,
        total: PLAN_SEQUENCE.length,
        startedAt,
        etaTargetAt: secondStepStart + ESTIMATED_PLAN_MS,
      });

      const executionResult = await requestPlan(selectedCandidate, "plan");
      setPlanResults({ prd: prdResult, plan: executionResult });
      setPlanState({
        stage: "complete",
        message: "PRD and Execution Plan are ready.",
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
        message: "Generation failed before both outputs completed.",
        etaTargetAt: null,
      }));
    } finally {
      setPlanning(false);
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
      throw new Error(payload.error ?? `Failed to generate ${type === "prd" ? "PRD" : "Execution Plan"}.`);
    }

    return payload;
  }

  function exportResearchResults() {
    if (!report) {
      return;
    }

    const envelope: ExportEnvelope = {
      app: "niche-validator-studio",
      version: 1,
      exportedAt: new Date().toISOString(),
      report,
    };

    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const fileName = `${toSlug(report.query || "auto-niche")}-${report.generatedAt.slice(0, 10)}-research.json`;
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function openImportDialog() {
    importFileRef.current?.click();
  }

  async function onImportResults(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const imported = extractResearchReport(parsed);
      if (!imported) {
        setError("Invalid research export file. Expected a Niche Validator research payload.");
        return;
      }

      setReport(imported);
      setError(null);
      setPlanError(null);
      setImportNote(`Loaded research from ${file.name}.`);
      setPlanResults({});
      setPlanState(EMPTY_PLAN_STATE);
    } catch {
      setError("Could not import file. Make sure it is valid JSON exported from this app.");
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
        <p className="nv-kicker">Niche Validator Studio</p>
        <h1>Find AI-buildable niches with real spending, pain, and launch room.</h1>
        <p>
          Enter a niche or leave blank to discover opportunities from Reddit, X, and the Web across the last 30 days.
          Select a validated niche and generate both a PRD and execution plan.
        </p>
      </header>

      <div className="nv-shell">
        <section className="nv-card nv-form-card">
          <form onSubmit={onSubmit} className="nv-form">
            <label htmlFor="niche">Niche (optional)</label>
            <textarea
              id="niche"
              value={niche}
              onChange={(event) => setNiche(event.target.value)}
              placeholder="Example: AI workflow automation for dental practices"
              rows={4}
            />
            <small className="nv-hint">Leave blank to discover niches from all sources in the last 30 days.</small>

            <div className="nv-example-row">
              {EXAMPLE_NICHES.map((example) => (
                <button type="button" key={example} className="nv-chip" onClick={() => setNiche(example)}>
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
            </div>

            {error ? <p className="nv-error">{error}</p> : null}
            {importNote ? <p className="nv-note">{importNote}</p> : null}

            <button type="submit" className="nv-submit" disabled={loading}>
              {loading ? "Validating niches..." : "Run Niche Validator"}
            </button>

            <div className="nv-file-actions">
              <button type="button" className="nv-ghost" onClick={openImportDialog}>
                Import Results
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
              onChange={onImportResults}
            />
          </form>
        </section>

        <section className="nv-card nv-results-card">
          {loading ? (
            <div className="nv-loading">
              <div className="nv-spinner" aria-hidden />
              <h3>{progress?.message ?? "Starting niche validator..."}</h3>
              <p>
                Elapsed <strong>{formatDuration(elapsedMs)}</strong>
                {etaTargetAt ? (
                  <>
                    {" "}
                    • ETA <strong>{formatDuration(remainingMs)}</strong>
                  </>
                ) : null}
              </p>
              <div className="nv-progress-track" aria-hidden>
                <div className="nv-progress-fill" style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }} />
              </div>
              <small>
                {progress?.completedSteps ?? 0}/{progress?.totalSteps ?? 0} steps complete
              </small>
            </div>
          ) : null}

          {!report && !loading ? (
            <div className="nv-empty">
              <h2>Ready to validate.</h2>
              <p>Run a search to identify niches with buyer spend, recurring pain, and a launchable community.</p>
            </div>
          ) : null}

          {report ? (
            <>
              <div className="nv-summary-bar">
                <StatTile label="Candidates" value={report.stats.total} />
                <StatTile label="All 3 checks pass" value={report.stats.passed} />
                <StatTile label="Mode" value={report.mode} />
                <StatTile label="Runtime" value={formatDuration(report.stats.elapsedMs)} />
              </div>

              <div className="nv-summary-meta">
                <span>{report.discoveryMode ? "Auto-discovery mode" : `Focused niche: ${report.query || "n/a"}`}</span>
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

              {visibleCandidates.length ? (
                <p className="nv-pass-note">Showing only niches that passed spending, pain, and room checks.</p>
              ) : (
                <p className="nv-pass-note is-warning">
                  No niches passed all three checks in this run. Try a different niche or switch to deep research.
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
                        <small>Score {candidate.score}/100</small>
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

                  <p className="nv-lead">{selectedCandidate.aiBuildAngle}</p>
                  <p className="nv-meta">
                    Audience: {selectedCandidate.audience || "n/a"} • Community: {selectedCandidate.checks.room.communityName}
                  </p>

                  <div className="nv-detail-grid">
                    <CheckBlock title="Spending" lines={selectedCandidate.checks.spending.evidence} />
                    <CheckBlock title="Pain" lines={selectedCandidate.checks.pain.evidence} />
                    <CheckBlock title="Room" lines={selectedCandidate.checks.room.evidence} />
                  </div>

                  <div className="nv-source-list">
                    {selectedCandidate.sources.slice(0, 8).map((source) => (
                      <a key={`${source.url}-${source.title}`} href={source.url} target="_blank" rel="noreferrer">
                        <span>{source.type}</span>
                        {source.title}
                      </a>
                    ))}
                  </div>

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

                  <button type="button" className="nv-submit" onClick={onGenerateOutputs} disabled={planning}>
                    {planning ? "Generating outputs..." : "Proceed: Generate PRD + Execution Plan"}
                  </button>
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
                        <h2>{type === "prd" ? "PRD" : "Execution Plan"}</h2>
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

  return typed as NicheResearchResponse;
}

function depthHint(depth: NicheResearchDepth) {
  if (depth === "quick") {
    return "~8 min runtime";
  }

  if (depth === "deep") {
    return "~11 min runtime";
  }

  return "~10 min runtime";
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

function toSlug(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "niche-validator-output";
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

function CheckBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <section className="nv-check-block">
      <h4>{title}</h4>
      {lines.length ? (
        <ul>
          {lines.map((line, index) => (
            <li key={`${title}-${index}`}>{line}</li>
          ))}
        </ul>
      ) : (
        <p>No evidence captured.</p>
      )}
    </section>
  );
}
