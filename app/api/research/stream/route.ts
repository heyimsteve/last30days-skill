import { NicheResearchDepth, NicheResearchResponse } from "@/lib/niche-types";
import { runNicheResearch } from "@/lib/server/niche-research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface ResearchRequestBody {
  niche?: unknown;
  depth?: unknown;
}

interface StreamPayload {
  type: "ready" | "progress" | "result" | "error";
  progress?: unknown;
  report?: NicheResearchResponse;
  error?: string;
}

export async function POST(request: Request) {
  let body: ResearchRequestBody;

  try {
    body = (await request.json()) as ResearchRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const niche = typeof body.niche === "string" ? body.niche.trim() : "";
  const depth = isDepth(body.depth) ? body.depth : "default";

  if (niche.length > 160) {
    return jsonError("Niche must be 160 characters or fewer.", 400);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: StreamPayload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      void (async () => {
        try {
          send({ type: "ready" });

          const report = await runNicheResearch(
            { niche, mode: depth },
            {
              onProgress: (progress) => {
                send({ type: "progress", progress });
              },
            },
          );

          send({ type: "result", report });
        } catch (error) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : "Unexpected error while running niche research.",
          });
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function isDepth(value: unknown): value is NicheResearchDepth {
  return value === "quick" || value === "default" || value === "deep";
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
