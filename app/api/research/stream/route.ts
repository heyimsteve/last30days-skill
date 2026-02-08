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
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const days = Number.isFinite(body.days) ? Number(body.days) : 30;
  const depth = isDepth(body.depth) ? body.depth : "default";
  const sources = parseSources(body.sources);

  if (!topic) {
    return jsonError("Topic is required.", 400);
  }
  if (topic.length < 2) {
    return jsonError("Topic must be at least 2 characters.", 400);
  }
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return jsonError("Days must be an integer between 1 and 30.", 400);
  }
  if (!sources.length) {
    return jsonError("Select at least one source.", 400);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      void (async () => {
        try {
          send({ type: "ready" });

          const report = await runResearch(
            { topic, days, depth, sources },
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
            error: error instanceof Error ? error.message : "Unexpected error while running research.",
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

function parseSources(value: unknown): SourceType[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is SourceType => item === "reddit" || item === "x" || item === "web");
}

function isDepth(value: unknown): value is ResearchDepth {
  return value === "quick" || value === "default" || value === "deep";
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
