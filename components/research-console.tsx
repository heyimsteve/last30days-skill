"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { ResearchResponse, SearchItem, SourceType } from "@/lib/types";

const SOURCE_OPTIONS: Array<{ id: SourceType; label: string; hint: string }> = [
  { id: "reddit", label: "Reddit", hint: "community discussion" },
  { id: "x", label: "X", hint: "real-time social signal" },
  { id: "web", label: "Web", hint: "docs, blogs, news" },
];

const EXAMPLE_TOPICS = [
  "Higgsfield Vibe Motion prompting",
  "Best Claude Code workflow upgrades",
  "Latest OpenAI Responses API patterns",
  "MCP server tooling for AI agents",
];

type Depth = "quick" | "default" | "deep";
type SourceStatus = "pending" | "running" | "completed" | "failed";

interface ProgressEvent {
  stage: "starting" | "searching" | "processing" | "synthesizing" | "complete";
  message: string;
  elapsedMs: number;
  etaMs: number;
  completedSteps: number;
  totalSteps: number;
  sourceStatus: Partial<Record<SourceType, SourceStatus>>;
}

interface StreamPayload {
  type: "ready" | "progress" | "result" | "error";
  progress?: ProgressEvent;
  report?: ResearchResponse;
  error?: string;
}

export function ResearchConsole() {
  const [topic, setTopic] = useState("");
  const [days, setDays] = useState(30);
  const [depth, setDepth] = useState<Depth>("default");
  const [sources, setSources] = useState<SourceType[]>(["reddit", "x", "web"]);

  const [report, setReport] = useState<ResearchResponse | null>(null);
  const [activeTab, setActiveTab] = useState<SourceType>("reddit");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [etaTargetAt, setEtaTargetAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading) {
      return;
    }

    const timer = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading]);

  const activeItems = useMemo(() => {
    if (!report) {
      return [];
    }

    if (activeTab === "reddit") {
      return report.reddit;
    }
    if (activeTab === "x") {
      return report.x;
    }
    return report.web;
  }, [activeTab, report]);

  const errors = useMemo(() => {
    if (!report) {
      return [];
    }

    return Object.entries(report.errors)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => ({ key, value: value as string }));
  }, [report]);

  const elapsedMs = runStartedAt ? Math.max(0, clockNow - runStartedAt) : 0;
  const remainingMs = etaTargetAt ? Math.max(0, etaTargetAt - clockNow) : 0;

  const progressPercent = useMemo(() => {
    if (!progress || progress.totalSteps <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round((progress.completedSteps / progress.totalSteps) * 100)));
  }, [progress]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!topic.trim()) {
      setError("Enter a topic to research.");
      return;
    }

    if (!sources.length) {
      setError("Choose at least one source.");
      return;
    }

    setLoading(true);
    setError(null);
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
          topic: topic.trim(),
          days,
          depth,
          sources,
        }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as { error?: string };
          setError(payload.error ?? "Research request failed.");
        } else {
          setError("Research request failed.");
        }
        return;
      }

      const body = response.body;
      if (!body) {
        setError("No stream received from research endpoint.");
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
            const nextReport = payload.report;
            gotResult = true;
            setReport(nextReport);

            if (nextReport.stats.reddit > 0) {
              setActiveTab("reddit");
            } else if (nextReport.stats.x > 0) {
              setActiveTab("x");
            } else {
              setActiveTab("web");
            }

            continue;
          }

          if (payload.type === "error") {
            gotError = true;
            setError(payload.error ?? "Research failed.");
          }
        }
      }

      if (!gotResult && !gotError) {
        setError("Research stream ended before a final result was returned.");
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Unexpected request failure.";
      setError(message);
    } finally {
      setLoading(false);
      setEtaTargetAt(null);
    }
  }

  function toggleSource(source: SourceType) {
    setSources((current) => {
      if (current.includes(source)) {
        return current.filter((item) => item !== source);
      }
      return [...current, source];
    });
  }

  return (
    <div className="page-shell">
      <header className="hero">
        <p className="eyebrow">Last 30 Days Research Lab</p>
        <h1>Search Reddit, X, and the Web. Then auto-synthesize with Claude.</h1>
        <p>
          End-to-end research pipeline with source controls, date filtering, scoring, dedupe, real-time progress tracking,
          and one-click synthesis.
        </p>
      </header>

      <div className="app-grid">
        <section className="panel query-panel">
          <form onSubmit={onSubmit} className="query-form">
            <label htmlFor="topic">Topic</label>
            <textarea
              id="topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="What do you want researched from the last 30 days?"
              rows={4}
            />

            <div className="example-row">
              {EXAMPLE_TOPICS.map((example) => (
                <button
                  type="button"
                  key={example}
                  className="example-chip"
                  onClick={() => setTopic(example)}
                >
                  {example}
                </button>
              ))}
            </div>

            <div className="form-row">
              <label htmlFor="days">Lookback window: {days} days</label>
              <input
                id="days"
                type="range"
                min={1}
                max={30}
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              />
            </div>

            <div className="form-row">
              <span className="field-label">Depth</span>
              <div className="depth-group">
                {(["quick", "default", "deep"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`depth-btn ${depth === value ? "is-active" : ""}`}
                    onClick={() => setDepth(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-row">
              <span className="field-label">Sources (multi-select)</span>
              <div className="source-grid">
                {SOURCE_OPTIONS.map((option) => {
                  const selected = sources.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`source-card ${selected ? "is-selected" : ""}`}
                      onClick={() => toggleSource(option.id)}
                    >
                      <span>{option.label}</span>
                      <small>{option.hint}</small>
                    </button>
                  );
                })}
              </div>
            </div>

            {error ? <p className="error-text">{error}</p> : null}

            <button type="submit" className="submit-btn" disabled={loading}>
              {loading ? "Researching..." : "Run Research"}
            </button>
          </form>
        </section>

        <section className="panel results-panel">
          {loading ? (
            <div className="loading-state is-inline">
              <div className="spinner" aria-hidden />
              <h3>{progress?.message ?? "Starting research..."}</h3>
              <p>
                Elapsed: <strong>{formatDuration(elapsedMs)}</strong>
                {etaTargetAt ? (
                  <>
                    {" "}
                    • ETA: <strong>{formatDuration(remainingMs)}</strong>
                  </>
                ) : null}
              </p>

              <div className="progress-track" aria-hidden>
                <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>
              <small>
                {progress?.completedSteps ?? 0}/{progress?.totalSteps ?? 0} steps completed
              </small>

              <div className="source-status-row">
                {SOURCE_OPTIONS.map((option) => (
                  <span key={option.id} className={`source-pill status-${progress?.sourceStatus[option.id] ?? "pending"}`}>
                    {option.label}: {progress?.sourceStatus[option.id] ?? "pending"}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {!report ? (
            loading ? null : (
              <div className="empty-state">
                <h2>Ready to run.</h2>
                <p>Pick your sources and topic, then run research. Claude synthesis appears automatically after search.</p>
              </div>
            )
          ) : (
            <>
              <div className="stats-row">
                <StatCard label="Total" value={report.stats.total} />
                <StatCard label="Reddit" value={report.stats.reddit} />
                <StatCard label="X" value={report.stats.x} />
                <StatCard label="Web" value={report.stats.web} />
              </div>

              <div className="meta-row">
                <span>
                  Range: {report.range.from} to {report.range.to}
                </span>
                <span>Runtime: {formatDuration(report.stats.elapsedMs)}</span>
                <span>Generated: {new Date(report.stats.generatedAt).toLocaleString()}</span>
              </div>

              <article className="usage-card">
                <header>
                  <h3>Token Usage & Cost</h3>
                </header>
                <div className="usage-grid">
                  <div>
                    <small>Total tokens</small>
                    <strong>{formatNumber(report.usage.totalTokens)}</strong>
                  </div>
                  <div>
                    <small>Input tokens</small>
                    <strong>{formatNumber(report.usage.inputTokens)}</strong>
                  </div>
                  <div>
                    <small>Output tokens</small>
                    <strong>{formatNumber(report.usage.outputTokens)}</strong>
                  </div>
                  <div>
                    <small>Estimated cost (USD)</small>
                    <strong>${report.usage.costUsd.toFixed(6)}</strong>
                  </div>
                </div>
                <div className="usage-breakdown">
                  {Object.entries(report.usage.byOperation).map(([operation, usage]) => {
                    if (!usage) {
                      return null;
                    }

                    return (
                      <div key={operation} className="usage-row">
                        <span>{operation}</span>
                        <span>{formatNumber(usage.totalTokens)} tokens</span>
                        <span>${usage.costUsd.toFixed(6)}</span>
                        <span>{usage.model ?? "n/a"}</span>
                      </div>
                    );
                  })}
                </div>
              </article>

              {report.synthesis ? (
                <article className="synthesis-card">
                  {(() => {
                    const synthesis = report.synthesis;
                    if (!synthesis) {
                      return null;
                    }

                    return (
                      <>
                        <header>
                          <h2>Claude Synthesis</h2>
                          <button
                            type="button"
                            className="ghost-btn"
                            onClick={() => navigator.clipboard.writeText(formatSynthesis(synthesis))}
                          >
                            Copy
                          </button>
                        </header>

                        <p>{synthesis.summary}</p>

                        {synthesis.keyPatterns.length ? (
                          <ol>
                            {synthesis.keyPatterns.map((pattern) => (
                              <li key={pattern}>{pattern}</li>
                            ))}
                          </ol>
                        ) : null}

                        <div className="synth-footer">
                          <strong>Recommended format:</strong> {synthesis.recommendedFormat}
                        </div>
                        <div className="synth-footer">
                          <strong>Caveats:</strong> {synthesis.caveats}
                        </div>
                      </>
                    );
                  })()}
                </article>
              ) : (
                <article className="synthesis-card is-muted">
                  <h2>Claude Synthesis</h2>
                  <p>No synthesis was generated for this run.</p>
                </article>
              )}

              {errors.length ? (
                <article className="error-box">
                  <h3>Partial errors</h3>
                  <ul>
                    {errors.map((item) => (
                      <li key={item.key}>
                        <strong>{item.key}:</strong> {item.value}
                      </li>
                    ))}
                  </ul>
                </article>
              ) : null}

              <div className="tabs">
                {SOURCE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`tab ${activeTab === option.id ? "is-active" : ""}`}
                    onClick={() => setActiveTab(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="items-list">
                {activeItems.length ? (
                  activeItems.map((item) => <ResultCard key={item.id + item.url} item={item} />)
                ) : (
                  <p className="empty-source">No {activeTab} results in this run.</p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
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

function formatSynthesis(synthesis: NonNullable<ResearchResponse["synthesis"]>) {
  const lines = [
    `Summary: ${synthesis.summary}`,
    "",
    "Key patterns:",
    ...synthesis.keyPatterns.map((pattern, index) => `${index + 1}. ${pattern}`),
    "",
    `Recommended format: ${synthesis.recommendedFormat}`,
    `Caveats: ${synthesis.caveats}`,
  ];

  return lines.join("\n");
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ResultCard({ item }: { item: SearchItem }) {
  const date = item.date ?? "unknown";

  if (item.source === "reddit") {
    return (
      <article className="result-card">
        <header>
          <span className="pill">Reddit</span>
          <span>Score {item.score}</span>
        </header>
        <h4>{item.title}</h4>
        <p className="meta">r/{item.subreddit} • {date}</p>
        <p>{item.why_relevant || "No relevance notes returned."}</p>
        <a href={item.url} target="_blank" rel="noreferrer">
          Open source
        </a>
      </article>
    );
  }

  if (item.source === "x") {
    return (
      <article className="result-card">
        <header>
          <span className="pill">X</span>
          <span>Score {item.score}</span>
        </header>
        <h4>@{item.author_handle || "unknown"}</h4>
        <p>{item.text}</p>
        <p className="meta">{date}</p>
        <a href={item.url} target="_blank" rel="noreferrer">
          Open source
        </a>
      </article>
    );
  }

  return (
    <article className="result-card">
      <header>
        <span className="pill">Web</span>
        <span>Score {item.score}</span>
      </header>
      <h4>{item.title}</h4>
      <p className="meta">{item.source_domain} • {date}</p>
      <p>{item.snippet}</p>
      <a href={item.url} target="_blank" rel="noreferrer">
        Open source
      </a>
    </article>
  );
}
