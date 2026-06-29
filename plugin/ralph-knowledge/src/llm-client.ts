/**
 * Minimal OpenAI-compatible LLM client for Contextual Retrieval.
 *
 * Probes `${baseUrl}/v1/models` for availability and calls
 * `${baseUrl}/v1/chat/completions` to generate short context prefixes for
 * document chunks. Uses native `fetch` + `AbortController` — no SDK dependency.
 *
 * Fail-open semantics: network errors, timeouts, non-200 responses, and
 * malformed JSON all resolve without throwing. `available()` returns `false`;
 * `contextualize()` returns an empty string. The caller is expected to treat
 * an empty context prefix as "no context available" and continue.
 *
 * Defaults target `gemma-lab` at `http://localhost:8000` with the Gemma 4 26B
 * MXFP8 model. Override via `RALPH_LLM_URL` / `RALPH_LLM_MODEL` env vars or
 * explicit options.
 */

export interface LlmClientOptions {
  /** Base URL for the OpenAI-compatible endpoint. Default: RALPH_LLM_URL env or http://localhost:8000. */
  baseUrl?: string;
  /** Model identifier sent in chat completion requests. Default: RALPH_LLM_MODEL env or mlx-community/gemma-4-26b-a4b-it-mxfp8. */
  model?: string;
  /** Timeout for contextualize() in milliseconds. Default: 30000. */
  timeoutMs?: number;
}

export interface LlmClient {
  /**
   * Probe the endpoint for availability.
   * Returns `true` iff `${baseUrl}/v1/models` responds with HTTP 200 within 2000ms.
   * Returns `false` on timeout, connection refused, non-200, or any thrown exception.
   */
  available(): Promise<boolean>;

  /**
   * Generate a short (≤100 token) context prefix situating `chunkContent`
   * within `fullDocument`, using the Anthropic Contextual Retrieval prompt.
   *
   * Returns the trimmed content string on success, or `""` on any error
   * (network failure, timeout, non-2xx response, missing choices, malformed JSON).
   */
  contextualize(fullDocument: string, chunkContent: string): Promise<string>;

  /**
   * General single-prompt chat completion (used by `knowledge_think`).
   *
   * Returns the trimmed assistant content on success, or `""` on any error
   * (network failure, timeout, non-2xx, missing choices, malformed JSON) so
   * callers can fail open. `maxTokens` defaults to 1024.
   */
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_MODEL = "mlx-community/gemma-4-26b-a4b-it-mxfp8";
const DEFAULT_TIMEOUT_MS = 30000;
const AVAILABLE_PROBE_TIMEOUT_MS = 2000;
const MAX_CONTEXT_TOKENS = 120;

/**
 * Anthropic Contextual Retrieval prompt, verbatim from the parent plan Phase 2.
 * Placeholders `{fullDocument}` and `{chunkContent}` are filled at call time.
 */
function buildContextualizePrompt(fullDocument: string, chunkContent: string): string {
  return `<document>
${fullDocument}
</document>

Here is the chunk we want to situate within the whole document:

<chunk>
${chunkContent}
</chunk>

Please give a short succinct context to situate this chunk within the overall
document for the purposes of improving search retrieval of the chunk. Answer only
with the succinct context and nothing else.`;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export function createLlmClient(opts: LlmClientOptions = {}): LlmClient {
  const baseUrl = opts.baseUrl ?? process.env.RALPH_LLM_URL ?? DEFAULT_BASE_URL;
  const model = opts.model ?? process.env.RALPH_LLM_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function available(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AVAILABLE_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        method: "GET",
        signal: controller.signal,
      });
      return response.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function contextualize(fullDocument: string, chunkContent: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const prompt = buildContextualizePrompt(fullDocument, chunkContent);
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: MAX_CONTEXT_TOKENS,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return "";
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return "";
      }
      return content.trim();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  async function complete(
    prompt: string,
    completeOpts: { maxTokens?: number } = {},
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: completeOpts.maxTokens ?? 1024,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return "";
      const data = (await response.json()) as ChatCompletionResponse;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") return "";
      return content.trim();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  return { available, contextualize, complete };
}
