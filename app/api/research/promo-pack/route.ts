import { NextResponse } from "next/server";

import { NicheCandidate } from "@/lib/niche-types";
import { generatePromoPack } from "@/lib/server/promo-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface PromoPackRequestBody {
  candidate?: unknown;
}

export async function POST(request: Request) {
  let body: PromoPackRequestBody;

  try {
    body = (await request.json()) as PromoPackRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isCandidate(body.candidate)) {
    return NextResponse.json({ error: "A validated niche candidate is required." }, { status: 400 });
  }

  try {
    const promoPack = await generatePromoPack({
      candidate: body.candidate,
    });

    return NextResponse.json(promoPack, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error while generating promo pack.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
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
