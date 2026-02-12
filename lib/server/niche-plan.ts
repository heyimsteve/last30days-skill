import { NicheCandidate, NichePlanResponse, PlanOutputType } from "@/lib/niche-types";
import { extractUsage, openRouterRequest } from "@/lib/server/openrouter";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
}

const PLAN_MODEL_DEFAULT = "anthropic/claude-sonnet-4.5";

export async function generateNichePlanMarkdown({
  candidate,
  type,
}: {
  candidate: NicheCandidate;
  type: PlanOutputType;
}): Promise<NichePlanResponse> {
  const model = process.env.OPENROUTER_PLAN_MODEL ?? PLAN_MODEL_DEFAULT;

  const system =
    "You are a principal product strategist. Produce high-quality markdown only, grounded in the provided validation context.";

  const user = buildPlanPrompt(candidate, type);

  const response = await openRouterRequest<ChatCompletionResponse>({
    path: "/chat/completions",
    payload: {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      max_tokens: 4200,
    },
    timeoutMs: 120000,
  });

  const markdown = response.choices?.[0]?.message?.content?.trim() || "# Output\n\nNo markdown was generated.";
  const usage = extractUsage(response as unknown as Record<string, unknown>);
  const outputLabel = type === "prd" ? "PRD" : type === "market" ? "Market Plan" : "Execution Plan";

  return {
    title: `${candidate.name} ${outputLabel}`,
    type,
    markdown,
    generatedAt: new Date().toISOString(),
    usage: {
      ...usage,
      calls: 1,
      model,
    },
  };
}

function buildPlanPrompt(candidate: NicheCandidate, type: PlanOutputType) {
  const descriptor =
    type === "prd"
      ? "Product Requirements Document"
      : type === "market"
        ? "market plan with GTM and monetization detail"
        : "build and go-to-market execution plan";

  const outputLabel = type === "prd" ? "PRD" : type === "market" ? "Market Plan" : "Execution Plan";
  const sectionFiveLabel = type === "prd" ? "PRD" : type === "market" ? "Market Plan" : "Build Plan";
  const sectionSixLabel = type === "market" ? "Channel and Funnel Architecture" : "End-to-End Implementation Plan (technical)";
  const sectionNineLabel = type === "market" ? "90-Day GTM Roadmap" : "90-Day Roadmap";

  return `Create a ${descriptor} in markdown.

Candidate context:
- Niche: ${candidate.name}
- Problem statement: ${candidate.problemStatement}
- One-liner: ${candidate.oneLiner}
- AI build angle: ${candidate.aiBuildAngle}
- ICP: ${candidate.icp}
- Audience: ${candidate.audience}
- Why now: ${candidate.whyNow}
- Recommendation: ${candidate.recommendation}
- Score: ${candidate.score}
- Verdict: ${candidate.verdict}
- Proof points:
${candidate.proofPoints.map((point) => `  - [${point.sourceType}] ${point.claim} (${point.sourceUrl})`).join("\n") || "  - none"}

Demand snapshot:
- Trend: ${candidate.demand.trendSummary}
- Urgency drivers: ${candidate.demand.urgencyDrivers.join(", ") || "n/a"}
- Buying signals: ${candidate.demand.buyingSignals.join(", ") || "n/a"}
- Search keywords: ${candidate.demand.searchKeywords.join(", ") || "n/a"}

Market landscape:
- Competition level: ${candidate.landscape.competitionLevel}
- Incumbents: ${candidate.landscape.incumbentTypes.join(", ") || "n/a"}
- Whitespace: ${candidate.landscape.whitespace.join(", ") || "n/a"}
- Beachhead wedge: ${candidate.landscape.beachheadWedge}

Business model:
- Pricing model: ${candidate.businessModel.pricingModel}
- Price anchor: ${candidate.businessModel.priceAnchor}
- Time to first dollar: ${candidate.businessModel.timeToFirstDollar}
- Gross margin profile: ${candidate.businessModel.expectedGrossMargin}

Go-to-market:
- Channels: ${candidate.goToMarket.channels.join(", ") || "n/a"}
- Offer hook: ${candidate.goToMarket.offerHook}
- Sales motion: ${candidate.goToMarket.salesMotion}
- Retention loop: ${candidate.goToMarket.retentionLoop}

Execution blueprint:
- Build complexity: ${candidate.execution.buildComplexity}
- Stack recommendation: ${candidate.execution.stackRecommendation}
- MVP scope: ${candidate.execution.mvpScope.join(", ") || "n/a"}
- Automation levers: ${candidate.execution.automationLevers.join(", ") || "n/a"}
- Moat levers: ${candidate.execution.moatLevers.join(", ") || "n/a"}

Outcome scoring:
- Time to first dollar (days): ${candidate.outcomes.timeToFirstDollarDays}
- GTM difficulty (1-10): ${candidate.outcomes.gtmDifficulty}
- Integration complexity (1-10): ${candidate.outcomes.integrationComplexity}
- Weighted outcome score: ${candidate.outcomes.weightedScore}

Competitor intelligence:
${candidate.competitors.map((competitor) => `- ${competitor.name}: ${competitor.pricingSummary} | friction: ${competitor.onboardingFriction} | sentiment: ${competitor.reviewSentiment} | ${competitor.url}`).join("\n") || "- none"}

Persona variants:
${candidate.personaVariants.map((persona) => `- ${persona.persona}: pain=${persona.primaryPain}; offer=${persona.offerVariant}; price=${persona.pricingAngle}; channel=${persona.bestChannel}`).join("\n") || "- none"}

Validation experiments:
${candidate.validationPlan.map((step) => `- ${step.experiment} | success: ${step.successMetric} | effort: ${step.effort}`).join("\n") || "- none"}

Key risks:
${candidate.risks.map((risk) => `- ${risk}`).join("\n") || "- none"}

Kill criteria:
${candidate.killCriteria.map((item) => `- ${item}`).join("\n") || "- none"}

Validation checks:
Spending:
${candidate.checks.spending.evidence.map((line) => `- ${line}`).join("\n") || "- No spending evidence provided."}
Pain:
${candidate.checks.pain.evidence.map((line) => `- ${line}`).join("\n") || "- No pain evidence provided."}
Room:
${candidate.checks.room.evidence.map((line) => `- ${line}`).join("\n") || "- No room evidence provided."}

Sources:
${candidate.sources.map((source) => `- ${source.title} (${source.type}) - ${source.url} - ${source.note}`).join("\n") || "- No sources provided."}

Requirements:
- Return markdown only (no code fences).
- Assume this is for an indie founder building with AI end-to-end.
- Be specific enough to execute immediately.
- Include sections in this exact order:
  1. # ${candidate.name} - ${outputLabel}
  2. ## Opportunity Snapshot
  3. ## Niche Validation Summary
  4. ## Product Strategy
  5. ## ${sectionFiveLabel}
  6. ## ${sectionSixLabel}
  7. ## Community Launch and Sales Plan
  8. ## Product Design Spec
  9. ## ${sectionNineLabel}
  10. ## Risks, Assumptions, and Kill Criteria

Additional constraints:
- In "Community Launch and Sales Plan", include: positioning, outreach scripts, first 10 customer plan, pricing ladder, and weekly KPIs.
- In "Product Design Spec", include: user personas, primary job-to-be-done, IA, core screens, UX principles, mobile considerations, and conversion-focused UI details.
- In implementation sections, call out recommended stack and AI components.
- Include acceptance criteria as bullet points under the ${sectionFiveLabel} section.
- If output type is Market Plan, include: channel mix assumptions, sales funnel conversion targets, pricing tests, and content calendar milestones.`;
}
