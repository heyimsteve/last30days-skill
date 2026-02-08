const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

interface RequestOptions {
  path: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}

export interface OpenRouterUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

function getApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing. Add it to your environment.");
  }
  return apiKey;
}

export async function openRouterRequest<T>({ path, payload, timeoutMs = 120000 }: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://last30days-next.local",
          "X-Title": "last30days-next",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    }

    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message ?? `OpenRouter error (${response.status})`;
      throw new Error(message);
    }

    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export function extractTextFromOpenRouterResponse(response: Record<string, unknown>): string {
  const outputText = response.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }

  const output = response.output;

  if (typeof output === "string") {
    return output;
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === "string") {
        return item;
      }
      if (!item || typeof item !== "object") {
        continue;
      }

      const typedItem = item as { type?: string; content?: unknown; text?: string };
      if (typedItem.type === "message" && Array.isArray(typedItem.content)) {
        for (const contentPart of typedItem.content) {
          if (!contentPart || typeof contentPart !== "object") {
            continue;
          }
          const piece = contentPart as { type?: string; text?: string };
          if (piece.type === "output_text" && typeof piece.text === "string") {
            return piece.text;
          }
        }
      }

      if (typeof typedItem.text === "string") {
        return typedItem.text;
      }
    }
  }

  const choices = response.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") {
        continue;
      }
      const content = (choice as { message?: { content?: unknown } }).message?.content;
      if (typeof content === "string") {
        return content;
      }
    }
  }

  return "";
}

export function extractJsonObject<T>(text: string): T | null {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1] ?? text;

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonSlice) as T;
  } catch {
    return null;
  }
}

export function extractUsage(response: Record<string, unknown>): OpenRouterUsage {
  const usage = (response.usage ?? {}) as Record<string, unknown>;

  const inputTokens = toNumber(
    usage.input_tokens ??
      usage.prompt_tokens ??
      usage.inputTokens ??
      usage.promptTokens,
  );

  const outputTokens = toNumber(
    usage.output_tokens ??
      usage.completion_tokens ??
      usage.outputTokens ??
      usage.completionTokens,
  );

  const totalTokens = toNumber(
    usage.total_tokens ??
      usage.totalTokens ??
      inputTokens + outputTokens,
  );

  const costUsd = toNumber(usage.cost ?? usage.total_cost ?? usage.totalCost);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
  };
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
