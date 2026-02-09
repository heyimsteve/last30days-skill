import { NextResponse } from "next/server";

import { NicheCandidate, PlanOutputType } from "@/lib/niche-types";
import { generateNichePlanMarkdown } from "@/lib/server/niche-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface PlanRequestBody {
  candidate?: unknown;
  type?: unknown;
}

export async function POST(request: Request) {
  let body: PlanRequestBody;

  try {
    body = (await request.json()) as PlanRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isCandidate(body.candidate)) {
    return NextResponse.json({ error: "A validated niche candidate is required." }, { status: 400 });
  }

  if (!hasPassingChecks(body.candidate)) {
    return NextResponse.json(
      { error: "Selected candidate must pass spending, pain, and room checks before generating a plan." },
      { status: 400 },
    );
  }

  const type = isPlanType(body.type) ? body.type : "prd";

  try {
    const plan = await generateNichePlanMarkdown({
      candidate: body.candidate,
      type,
    });

    return NextResponse.json(plan, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error while generating markdown output.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isPlanType(value: unknown): value is PlanOutputType {
  return value === "prd" || value === "plan";
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

function hasPassingChecks(candidate: NicheCandidate) {
  return candidate.checks.spending.passed && candidate.checks.pain.passed && candidate.checks.room.passed;
}
