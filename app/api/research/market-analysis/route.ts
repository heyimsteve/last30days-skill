import { NextResponse } from "next/server";

import { NicheCandidate, NicheResearchDepth } from "@/lib/niche-types";
import { runMarketAnalysis } from "@/lib/server/market-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface MarketAnalysisRequestBody {
  candidate?: unknown;
  depth?: unknown;
}

export async function POST(request: Request) {
  let body: MarketAnalysisRequestBody;

  try {
    body = (await request.json()) as MarketAnalysisRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isCandidate(body.candidate)) {
    return NextResponse.json({ error: "A validated niche candidate is required." }, { status: 400 });
  }

  const depth = isDepth(body.depth) ? body.depth : "default";

  try {
    const analysis = await runMarketAnalysis({
      candidate: body.candidate,
      mode: depth,
    });

    return NextResponse.json(analysis, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error while generating market analysis.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isDepth(value: unknown): value is NicheResearchDepth {
  return value === "quick" || value === "default" || value === "deep";
}

function isCandidate(value: unknown): value is NicheCandidate {
  if (!value || typeof value !== "object") {
    return false;
  }

  const typed = value as { id?: unknown; name?: unknown; checks?: unknown };
  if (typeof typed.id !== "string" || typeof typed.name !== "string") {
    return false;
  }

  if (!typed.checks || typeof typed.checks !== "object") {
    return false;
  }

  return true;
}
