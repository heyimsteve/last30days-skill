import { NextResponse } from "next/server";

import { NicheResearchDepth } from "@/lib/niche-types";
import { runNicheResearch, runNicheResearchBatch } from "@/lib/server/niche-research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

interface ResearchRequestBody {
  niche?: unknown;
  niches?: unknown;
  depth?: unknown;
  resumeKey?: unknown;
}

export async function POST(request: Request) {
  let body: ResearchRequestBody;

  try {
    body = (await request.json()) as ResearchRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const niche = typeof body.niche === "string" ? body.niche.trim() : "";
  const niches =
    Array.isArray(body.niches)
      ? body.niches
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
      : [];
  const depth = isDepth(body.depth) ? body.depth : "default";
  const resumeKey = typeof body.resumeKey === "string" ? body.resumeKey.trim() : "";

  if (niche.length > 160 || niches.some((value) => value.length > 160)) {
    return NextResponse.json({ error: "Niche must be 160 characters or fewer." }, { status: 400 });
  }

  if (niches.length > 8) {
    return NextResponse.json({ error: "You can run up to 8 niches per batch." }, { status: 400 });
  }

  if (resumeKey.length > 160) {
    return NextResponse.json({ error: "resumeKey must be 160 characters or fewer." }, { status: 400 });
  }

  const batchNiches = niches.length
    ? niches
    : niche
      ? [niche]
      : [];

  try {
    const report =
      batchNiches.length > 1
        ? await runNicheResearchBatch({ niches: batchNiches, mode: depth }, { abortSignal: request.signal })
        : await runNicheResearch({
            niche: batchNiches[0] ?? "",
            mode: depth,
          }, { abortSignal: request.signal, resumeKey: resumeKey || undefined });

    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error while running niche research.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isDepth(value: unknown): value is NicheResearchDepth {
  return value === "quick" || value === "default" || value === "deep";
}
