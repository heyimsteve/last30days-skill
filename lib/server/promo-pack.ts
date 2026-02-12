import { NicheCandidate, PromoPackResponse } from "@/lib/niche-types";
import { extractUsage, openRouterRequest } from "@/lib/server/openrouter";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
}

const PROMO_PACK_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";

export async function generatePromoPack({
  candidate,
}: {
  candidate: NicheCandidate;
}): Promise<PromoPackResponse> {
  const model = process.env.OPENROUTER_PLAN_MODEL ?? PROMO_PACK_MODEL_DEFAULT;

  const response = await openRouterRequest<ChatCompletionResponse>({
    path: "/chat/completions",
    payload: {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a direct-response growth strategist and product marketing lead. Produce practical, high-conviction markdown grounded in evidence.",
        },
        {
          role: "user",
          content: buildPromoPackPrompt(candidate),
        },
      ],
      temperature: 0.3,
      max_tokens: 4200,
    },
    timeoutMs: 120000,
  });

  const markdown =
    response.choices?.[0]?.message?.content?.trim() ||
    "# Promo Pack\n\nNo promotional pack was generated.";
  const usage = extractUsage(response as unknown as Record<string, unknown>);

  return {
    title: `${candidate.name} Promo Pack`,
    markdown,
    generatedAt: new Date().toISOString(),
    usage: {
      ...usage,
      calls: 1,
      model,
    },
  };
}

function buildPromoPackPrompt(candidate: NicheCandidate) {
  return `Create a complete promo and launch pack in markdown for this AI product.

Product context:
- Name: ${candidate.name}
- Problem: ${candidate.problemStatement}
- One-liner: ${candidate.oneLiner}
- Audience: ${candidate.audience}
- ICP: ${candidate.icp}
- AI Build Angle: ${candidate.aiBuildAngle}
- Offer Hook: ${candidate.goToMarket.offerHook}
- Pricing anchor: ${candidate.businessModel.priceAnchor}
- Sales motion: ${candidate.goToMarket.salesMotion}
- Channels: ${candidate.goToMarket.channels.join(", ") || "n/a"}

Evidence-backed proof points:
${candidate.proofPoints.map((item) => `- ${item.claim} (${item.sourceUrl})`).join("\n") || "- none"}

Validation context:
- Trend summary: ${candidate.demand.trendSummary}
- Buying signals: ${candidate.demand.buyingSignals.join(", ") || "n/a"}
- Risks: ${candidate.risks.join(", ") || "n/a"}

Requirements:
- Return markdown only (no code fences).
- Be conversion-focused and realistic. Do not promise guaranteed sales.
- Include all sections below in this order:
  1. # ${candidate.name} Promo Pack
  2. ## Positioning and Message House
  3. ## Offer Ladder and Pricing Narrative
  4. ## Sales Funnels (Inbound + Outbound)
  5. ## Video Scripts (Short-form + Long-form)
  6. ## 30-Day Content and Posting Schedule
  7. ## Email and DM Sequences
  8. ## Landing Page Copy Blocks
  9. ## FAQs and Objection Handling
  10. ## Podcast and Talk-Show Interview Answers
  11. ## Launch KPI Dashboard and Targets
  12. ## Weekly Optimization Loop

Additional constraints:
- Include at least 5 funnel assets with CTA examples.
- Include at least 8 scheduled content post ideas with channel and hook.
- Include at least 12 FAQs with concise answers.
- Include at least 12 interview Q&As.
- Include a practical KPI table with baseline/target columns.`;
}
