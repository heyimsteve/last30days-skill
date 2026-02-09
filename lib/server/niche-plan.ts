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

  return {
    title: `${candidate.name} ${type === "prd" ? "PRD" : "Execution Plan"}`,
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
  return `Create a ${type === "prd" ? "Product Requirements Document" : "build and go-to-market execution plan"} in markdown.

Candidate context:
- Niche: ${candidate.name}
- One-liner: ${candidate.oneLiner}
- AI build angle: ${candidate.aiBuildAngle}
- Audience: ${candidate.audience}
- Why now: ${candidate.whyNow}
- Recommendation: ${candidate.recommendation}
- Score: ${candidate.score}
- Verdict: ${candidate.verdict}

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
  1. # ${candidate.name} - ${type === "prd" ? "PRD" : "Execution Plan"}
  2. ## Opportunity Snapshot
  3. ## Niche Validation Summary
  4. ## Product Strategy
  5. ## ${type === "prd" ? "PRD" : "Build Plan"}
  6. ## End-to-End Implementation Plan (technical)
  7. ## Community Launch and Sales Plan
  8. ## Product Design Spec
  9. ## 90-Day Roadmap
  10. ## Risks, Assumptions, and Kill Criteria

Additional constraints:
- In "Community Launch and Sales Plan", include: positioning, outreach scripts, first 10 customer plan, pricing ladder, and weekly KPIs.
- In "Product Design Spec", include: user personas, primary job-to-be-done, IA, core screens, UX principles, mobile considerations, and conversion-focused UI details.
- In implementation sections, call out recommended stack and AI components.
- Include acceptance criteria as bullet points under the ${type === "prd" ? "PRD" : "Build Plan"} section.`;
}
