import { NextResponse } from "next/server";

import { ResearchDepth, runResearch } from "@/lib/server/research";
import { SourceType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface ResearchRequestBody {
  topic?: unknown;
  days?: unknown;
  depth?: unknown;
  sources?: unknown;
}

export async function POST(request: Request) {
  let body: ResearchRequestBody;

  try {
    body = (await request.json()) as ResearchRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const days = Number.isFinite(body.days) ? Number(body.days) : 30;
  const depth = isDepth(body.depth) ? body.depth : "default";
  const sources = parseSources(body.sources);

  if (!topic) {
    return NextResponse.json({ error: "Topic is required." }, { status: 400 });
  }

  if (topic.length < 2) {
    return NextResponse.json({ error: "Topic must be at least 2 characters." }, { status: 400 });
  }

  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return NextResponse.json({ error: "Days must be an integer between 1 and 30." }, { status: 400 });
  }

  if (!sources.length) {
    return NextResponse.json({ error: "Select at least one source." }, { status: 400 });
  }

  try {
    const report = await runResearch({
      topic,
      days,
      depth,
      sources,
    });

    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error while running research.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseSources(value: unknown): SourceType[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is SourceType => item === "reddit" || item === "x" || item === "web");
}

function isDepth(value: unknown): value is ResearchDepth {
  return value === "quick" || value === "default" || value === "deep";
}
