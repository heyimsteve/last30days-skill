import { NicheResearchDepth, NicheResearchResponse } from "@/lib/niche-types";
import { runNicheResearch, runNicheResearchBatch } from "@/lib/server/niche-research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

interface ResearchRequestBody {
  niche?: unknown;
  niches?: unknown;
  depth?: unknown;
  resumeKey?: unknown;
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
  const niches =
    Array.isArray(body.niches)
      ? body.niches
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
      : [];
  const depth = isDepth(body.depth) ? body.depth : "default";
  const resumeKey = typeof body.resumeKey === "string" ? body.resumeKey.trim() : "";

  if (niche.length > 160 || niches.some((value) => value.length > 160)) {
    return jsonError("Niche must be 160 characters or fewer.", 400);
  }

  if (niches.length > 8) {
    return jsonError("You can run up to 8 niches per batch.", 400);
  }

  if (resumeKey.length > 160) {
    return jsonError("resumeKey must be 160 characters or fewer.", 400);
  }

  const batchNiches = niches.length
    ? niches
    : niche
      ? [niche]
      : [];

  const encoder = new TextEncoder();
  let streamClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const closeSafely = () => {
        if (streamClosed) {
          return;
        }
        streamClosed = true;
        try {
          controller.close();
        } catch (error) {
          if (!isClosedControllerError(error)) {
            throw error;
          }
        }
      };

      const send = (payload: StreamPayload) => {
        if (streamClosed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch (error) {
          if (isClosedControllerError(error)) {
            streamClosed = true;
            return;
          }
          throw error;
        }
      };

      void (async () => {
        try {
          send({ type: "ready" });

          const report =
            batchNiches.length > 1
              ? await runNicheResearchBatch(
                  { niches: batchNiches, mode: depth },
                  {
                    abortSignal: request.signal,
                    onProgress: (progress) => {
                      send({ type: "progress", progress });
                    },
                  },
                )
              : await runNicheResearch(
                  { niche: batchNiches[0] ?? "", mode: depth },
                  {
                    abortSignal: request.signal,
                    resumeKey: resumeKey || undefined,
                    onProgress: (progress) => {
                      send({ type: "progress", progress });
                    },
                  },
                );

          send({ type: "result", report });
        } catch (error) {
          if (
            request.signal.aborted &&
            ((error instanceof DOMException && error.name === "AbortError") ||
              (error instanceof Error && error.name === "AbortError"))
          ) {
            return;
          }

          send({
            type: "error",
            error: error instanceof Error ? error.message : "Unexpected error while running niche research.",
          });
        } finally {
          closeSafely();
        }
      })();
    },
    cancel() {
      // Client paused/stopped/disconnected; avoid enqueue/close on a cancelled stream.
      streamClosed = true;
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

function isClosedControllerError(error: unknown) {
  return (
    error instanceof TypeError &&
    error.message.toLowerCase().includes("controller is already closed")
  );
}
