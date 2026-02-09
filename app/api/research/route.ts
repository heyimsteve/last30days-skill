import { NextResponse } from "next/server";

import { NicheResearchDepth } from "@/lib/niche-types";
import { runNicheResearch } from "@/lib/server/niche-research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface ResearchRequestBody {
  niche?: unknown;
  depth?: unknown;
}

export async function POST(request: Request) {
  let body: ResearchRequestBody;

  try {
    body = (await request.json()) as ResearchRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const niche = typeof body.niche === "string" ? body.niche.trim() : "";
  const depth = isDepth(body.depth) ? body.depth : "default";

  if (niche.length > 160) {
    return NextResponse.json({ error: "Niche must be 160 characters or fewer." }, { status: 400 });
  }

  try {
    const report = await runNicheResearch({
      niche,
      mode: depth,
    });

    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error while running niche research.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isDepth(value: unknown): value is NicheResearchDepth {
  return value === "quick" || value === "default" || value === "deep";
}
