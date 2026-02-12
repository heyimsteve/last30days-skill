import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { NicheCandidate, NicheResearchDepth, NicheResearchResponse, NicheTrendNews } from "@/lib/niche-types";
import { RedditItem, WebItem, XItem } from "@/lib/types";

const APP_ID = "last30days-opportunity-studio";

type RawRedditItem = Omit<RedditItem, "date_confidence" | "subs" | "score" | "source">;
type RawXItem = Omit<XItem, "date_confidence" | "subs" | "score" | "source">;
type RawWebItem = Omit<WebItem, "date_confidence" | "subs" | "score" | "source">;

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface NicheResearchCheckpoint {
  version: 1;
  niche: string;
  mode: NicheResearchDepth;
  startedAt: number;
  range: {
    from: string;
    to: string;
  };
  queries: string[];
  totalSteps: number;
  completedSteps: number;
  completedQueryCount: number;
  usageTotals: UsageTotals;
  allRaw: {
    reddit: RawRedditItem[];
    x: RawXItem[];
    web: RawWebItem[];
  };
  finalCandidates: NicheCandidate[] | null;
  enrichedCandidates: NicheCandidate[] | null;
  trendNews: NicheTrendNews[] | null;
  finalReport: NicheResearchResponse | null;
  updatedAt: string;
}

const CHECKPOINT_DIR = path.join(process.cwd(), "output", "checkpoints");
const RECOVERY_DIR = path.join(process.cwd(), "output", "recovery");

export async function loadNicheCheckpoint(key: string): Promise<NicheResearchCheckpoint | null> {
  if (!key.trim()) {
    return null;
  }

  const filePath = checkpointPath(key);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const typed = parsed as Partial<NicheResearchCheckpoint>;
    if (typed.version !== 1 || !Array.isArray(typed.queries) || !typed.usageTotals || !typed.allRaw) {
      return null;
    }

    return typed as NicheResearchCheckpoint;
  } catch {
    return null;
  }
}

export async function saveNicheCheckpoint(key: string, checkpoint: NicheResearchCheckpoint): Promise<void> {
  if (!key.trim()) {
    return;
  }

  const filePath = checkpointPath(key);
  await mkdir(CHECKPOINT_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(checkpoint), "utf8");
}

export async function clearNicheCheckpoint(key: string): Promise<void> {
  if (!key.trim()) {
    return;
  }

  const filePath = checkpointPath(key);
  await rm(filePath, { force: true });
}

export async function saveNicheRecoveryArtifact(input: {
  checkpointKey: string;
  checkpoint: NicheResearchCheckpoint;
  report: NicheResearchResponse;
  recoveryMessages: string[];
}): Promise<string> {
  const safeKey = sanitizeKey(input.checkpointKey || input.checkpoint.niche || "recovery");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${safeKey || "recovery"}-${timestamp}.json`;
  const filePath = path.join(RECOVERY_DIR, fileName);

  await mkdir(RECOVERY_DIR, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      {
        app: APP_ID,
        kind: "recovery-artifact",
        version: 1,
        savedAt: new Date().toISOString(),
        checkpointKey: input.checkpointKey,
        recoveryMessages: input.recoveryMessages,
        report: input.report,
        checkpoint: input.checkpoint,
      },
      null,
      2,
    ),
    "utf8",
  );

  return path.relative(process.cwd(), filePath);
}

function checkpointPath(key: string) {
  const safe = sanitizeKey(key);
  return path.join(CHECKPOINT_DIR, `${safe || "checkpoint"}.json`);
}

function sanitizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 140);
}
