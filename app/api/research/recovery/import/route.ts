import { NicheResearchCheckpoint, saveNicheCheckpoint } from "@/lib/server/niche-checkpoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RecoveryImportBody {
  resumeKey?: unknown;
  checkpoint?: unknown;
}

export async function POST(request: Request) {
  let body: RecoveryImportBody;

  try {
    body = (await request.json()) as RecoveryImportBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const resumeKey = typeof body.resumeKey === "string" ? body.resumeKey.trim() : "";
  const checkpoint = normalizeCheckpoint(body.checkpoint);

  if (!resumeKey) {
    return jsonError("resumeKey is required.", 400);
  }

  if (!checkpoint) {
    return jsonError("checkpoint payload is invalid.", 400);
  }

  await saveNicheCheckpoint(resumeKey, {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeCheckpoint(value: unknown): NicheResearchCheckpoint | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const typed = value as Partial<NicheResearchCheckpoint> & {
    allRaw?: {
      reddit?: unknown;
      x?: unknown;
      web?: unknown;
      youtube?: unknown;
    };
  };
  if (
    typed.version !== 1 ||
    typeof typed.niche !== "string" ||
    (typed.mode !== "quick" && typed.mode !== "default" && typed.mode !== "deep") ||
    !typed.range ||
    typeof typed.range.from !== "string" ||
    typeof typed.range.to !== "string" ||
    !Array.isArray(typed.queries) ||
    !typed.usageTotals ||
    !typed.allRaw
  ) {
    return null;
  }

  return {
    ...typed,
    allRaw: {
      reddit: Array.isArray(typed.allRaw?.reddit) ? typed.allRaw.reddit : [],
      x: Array.isArray(typed.allRaw?.x) ? typed.allRaw.x : [],
      web: Array.isArray(typed.allRaw?.web) ? typed.allRaw.web : [],
    },
  } as NicheResearchCheckpoint;
}
