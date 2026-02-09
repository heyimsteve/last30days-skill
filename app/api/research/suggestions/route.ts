import { NextResponse } from "next/server";

import { extractJsonObject, openRouterRequest } from "@/lib/server/openrouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface SuggestionBody {
  count?: unknown;
  niches?: unknown;
}

interface SuggestionResponse {
  suggestions?: unknown;
}

const FALLBACK_NICHES = [
  "Property management maintenance triage",
  "Dental insurance appeal automation",
  "Shopify returns fraud ops",
  "HVAC quote follow-up automation",
  "Construction bid qualification workflows",
  "Youtube sponsorship deal ops",
  "Legal intake form triage for family law",
  "Claims adjuster document summarization",
  "Mortgage broker lead nurture workflows",
  "Freight broker load matching ops",
  "Independent med spa retention campaigns",
  "Solar installer permit tracking",
  "Recruiting agency candidate follow-up",
  "Ecommerce chargeback evidence assembly",
  "Accounting firm monthly close automation",
  "Insurance agency renewal retention automation",
  "Community manager moderation copilot",
  "SaaS customer onboarding checklist automation",
  "Podcast guest outreach operations",
  "Nonprofit grant pipeline workflow automation",
];

export async function POST(request: Request) {
  let body: SuggestionBody;

  try {
    body = (await request.json()) as SuggestionBody;
  } catch {
    body = {};
  }

  const count = clampCount(body.count);
  const nicheSeeds =
    Array.isArray(body.niches)
      ? body.niches.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean).slice(0, 8)
      : [];

  try {
    const response = await openRouterRequest<SuggestionResponse>({
      path: "/chat/completions",
      payload: {
        model: process.env.OPENROUTER_NICHE_MODEL ?? "anthropic/claude-sonnet-4.5",
        messages: [
          {
            role: "system",
            content:
              "You generate startup niche prompts. Return strict JSON only with concise niche strings.",
          },
          {
            role: "user",
            content: `Generate ${count} niche ideas that are AI-buildable and have clear buyer pain, spend, and launch communities.

${nicheSeeds.length ? `Base them on these seed niches: ${nicheSeeds.join(", ")}.` : "Use broad market discovery."}

Constraints:
- Make each niche concrete and specific.
- Keep each niche under 8 words.
- Avoid duplicates and generic labels.
- Prioritize service-heavy or workflow-heavy industries.

Return JSON:
{
  "suggestions": ["string"]
}`,
          },
        ],
        temperature: 0.85,
        max_tokens: 900,
        response_format: { type: "json_object" },
      },
      timeoutMs: 45000,
    });

    const text = ((response as unknown as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "").trim();
    const parsed = extractJsonObject<SuggestionResponse>(text);
    const suggestions = normalizeSuggestions(parsed?.suggestions, count);

    if (suggestions.length) {
      return NextResponse.json({ suggestions, generatedAt: new Date().toISOString() }, { status: 200 });
    }
  } catch {
    // Ignore and return fallback.
  }

  return NextResponse.json(
    {
      suggestions: randomFallbackSuggestions(count),
      generatedAt: new Date().toISOString(),
    },
    { status: 200 },
  );
}

function clampCount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 8;
  }
  return Math.max(4, Math.min(16, Math.round(parsed)));
}

function normalizeSuggestions(value: unknown, count: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  const cleaned = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .map((item) => item.replace(/\s+/g, " "))
    .slice(0, count);

  return [...new Set(cleaned)];
}

function randomFallbackSuggestions(count: number) {
  const pool = [...FALLBACK_NICHES];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
