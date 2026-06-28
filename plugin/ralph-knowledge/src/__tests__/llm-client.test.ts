import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLlmClient } from "../llm-client.js";

type FetchFn = typeof globalThis.fetch;

const originalFetch: FetchFn | undefined = globalThis.fetch;

function installFetch(mock: FetchFn): void {
  globalThis.fetch = mock;
}

function restoreFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    // @ts-expect-error runtime cleanup when no original existed
    delete globalThis.fetch;
  }
}

function makeResponse(
  init: { status?: number; ok?: boolean; json?: unknown } = {},
): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    status,
    ok,
    json: async () => init.json ?? {},
  } as unknown as Response;
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function connectionRefused(): Error {
  // Node fetch surfaces connection-refused as a TypeError whose cause has
  // code `ECONNREFUSED`. Mimic the thrown error here.
  const err = new TypeError("fetch failed");
  (err as Error & { cause?: { code: string } }).cause = { code: "ECONNREFUSED" };
  return err;
}

describe("createLlmClient", () => {
  beforeEach(() => {
    delete process.env.RALPH_LLM_URL;
    delete process.env.RALPH_LLM_MODEL;
  });

  afterEach(() => {
    restoreFetch();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("available()", () => {
    it("returns true when /v1/models responds with status 200", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(makeResponse({ status: 200 }));
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.available();

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://localhost:8000/v1/models");
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns false when fetch rejects with AbortError (timeout)", async () => {
      const fetchMock = vi.fn<FetchFn>().mockRejectedValue(abortError());
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.available();

      expect(result).toBe(false);
    });

    it("returns false when fetch returns status 404", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(makeResponse({ status: 404 }));
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.available();

      expect(result).toBe(false);
    });

    it("returns false when fetch returns status 500", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(makeResponse({ status: 500 }));
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.available();

      expect(result).toBe(false);
    });

    it("returns false when fetch throws ECONNREFUSED", async () => {
      const fetchMock = vi.fn<FetchFn>().mockRejectedValue(connectionRefused());
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.available();

      expect(result).toBe(false);
    });

    it("aborts the probe after 2000ms", async () => {
      vi.useFakeTimers();
      let capturedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn<FetchFn>().mockImplementation((_input, init) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => reject(abortError()));
        });
      });
      installFetch(fetchMock);

      const client = createLlmClient();
      const probe = client.available();

      // Advance timers past the 2000ms probe timeout.
      await vi.advanceTimersByTimeAsync(2000);

      const result = await probe;
      expect(result).toBe(false);
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe("contextualize()", () => {
    it("returns mocked content on happy path (trimmed)", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(
        makeResponse({
          status: 200,
          json: {
            choices: [{ message: { content: "  This chunk discusses X.  " } }],
          },
        }),
      );
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.contextualize("doc body", "chunk");

      expect(result).toBe("This chunk discusses X.");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://localhost:8000/v1/chat/completions");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init?.body as string) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        max_tokens: number;
      };
      expect(body.model).toBe("mlx-community/gemma-4-26b-a4b-it-mxfp8");
      expect(body.max_tokens).toBe(120);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.role).toBe("user");
      // Prompt should embed both the document and the chunk verbatim in the
      // Anthropic Contextual Retrieval format.
      expect(body.messages[0]!.content).toContain("<document>\ndoc body\n</document>");
      expect(body.messages[0]!.content).toContain("<chunk>\nchunk\n</chunk>");
      expect(body.messages[0]!.content).toContain(
        "Please give a short succinct context",
      );
    });

    it("returns empty string on timeout (AbortError)", async () => {
      const fetchMock = vi.fn<FetchFn>().mockRejectedValue(abortError());
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.contextualize("doc", "chunk");

      expect(result).toBe("");
    });

    it("returns empty string on malformed response (no choices key)", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(
        makeResponse({ status: 200, json: { unexpected: "shape" } }),
      );
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.contextualize("doc", "chunk");

      expect(result).toBe("");
    });

    it("returns empty string when choices array is empty", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(
        makeResponse({ status: 200, json: { choices: [] } }),
      );
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.contextualize("doc", "chunk");

      expect(result).toBe("");
    });

    it("returns empty string when message.content is missing", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(
        makeResponse({ status: 200, json: { choices: [{ message: {} }] } }),
      );
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.contextualize("doc", "chunk");

      expect(result).toBe("");
    });

    it("returns empty string on non-2xx response", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(
        makeResponse({ status: 503, json: { error: "unavailable" } }),
      );
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.contextualize("doc", "chunk");

      expect(result).toBe("");
    });

    it("returns empty string on JSON parse error", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token in JSON");
        },
      } as unknown as Response);
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.contextualize("doc", "chunk");

      expect(result).toBe("");
    });

    it("returns empty string on network failure", async () => {
      const fetchMock = vi.fn<FetchFn>().mockRejectedValue(connectionRefused());
      installFetch(fetchMock);

      const client = createLlmClient();
      const result = await client.contextualize("doc", "chunk");

      expect(result).toBe("");
    });
  });

  describe("options and env overrides", () => {
    it("honors custom baseUrl option", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(makeResponse({ status: 200 }));
      installFetch(fetchMock);

      const client = createLlmClient({ baseUrl: "http://example.test:9000" });
      await client.available();

      expect(fetchMock.mock.calls[0]![0]).toBe("http://example.test:9000/v1/models");
    });

    it("honors custom model option in chat completion body", async () => {
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(
        makeResponse({
          status: 200,
          json: { choices: [{ message: { content: "ctx" } }] },
        }),
      );
      installFetch(fetchMock);

      const client = createLlmClient({ model: "custom/model-v1" });
      await client.contextualize("doc", "chunk");

      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
        model: string;
      };
      expect(body.model).toBe("custom/model-v1");
    });

    it("falls back to RALPH_LLM_URL env var", async () => {
      process.env.RALPH_LLM_URL = "http://env.override:1234";
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(makeResponse({ status: 200 }));
      installFetch(fetchMock);

      const client = createLlmClient();
      await client.available();

      expect(fetchMock.mock.calls[0]![0]).toBe("http://env.override:1234/v1/models");
    });

    it("falls back to RALPH_LLM_MODEL env var", async () => {
      process.env.RALPH_LLM_MODEL = "env/model-v2";
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(
        makeResponse({
          status: 200,
          json: { choices: [{ message: { content: "ctx" } }] },
        }),
      );
      installFetch(fetchMock);

      const client = createLlmClient();
      await client.contextualize("doc", "chunk");

      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
        model: string;
      };
      expect(body.model).toBe("env/model-v2");
    });

    it("prefers explicit options over env vars", async () => {
      process.env.RALPH_LLM_URL = "http://env.should-not-win:1234";
      process.env.RALPH_LLM_MODEL = "env/should-not-win";
      const fetchMock = vi.fn<FetchFn>().mockResolvedValue(
        makeResponse({
          status: 200,
          json: { choices: [{ message: { content: "ctx" } }] },
        }),
      );
      installFetch(fetchMock);

      const client = createLlmClient({
        baseUrl: "http://explicit.wins:5000",
        model: "explicit/model",
      });
      await client.contextualize("doc", "chunk");

      expect(fetchMock.mock.calls[0]![0]).toBe(
        "http://explicit.wins:5000/v1/chat/completions",
      );
      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
        model: string;
      };
      expect(body.model).toBe("explicit/model");
    });
  });

  describe("complete()", () => {
    it("returns trimmed content on a 200 response", async () => {
      installFetch(
        vi.fn(async () =>
          makeResponse({ json: { choices: [{ message: { content: "  hi there \n" } }] } }),
        ) as unknown as FetchFn,
      );
      const client = createLlmClient();
      expect(await client.complete("prompt")).toBe("hi there");
    });

    it("returns empty string on a non-2xx response", async () => {
      installFetch(vi.fn(async () => makeResponse({ status: 500 })) as unknown as FetchFn);
      const client = createLlmClient();
      expect(await client.complete("prompt")).toBe("");
    });

    it("returns empty string when content is missing/non-string", async () => {
      installFetch(
        vi.fn(async () => makeResponse({ json: { choices: [{ message: {} }] } })) as unknown as FetchFn,
      );
      const client = createLlmClient();
      expect(await client.complete("prompt")).toBe("");
    });

    it("returns empty string on a network error (fail-open)", async () => {
      installFetch(
        vi.fn(async () => {
          throw connectionRefused();
        }) as unknown as FetchFn,
      );
      const client = createLlmClient();
      expect(await client.complete("prompt")).toBe("");
    });

    it("passes the configured maxTokens in the request body", async () => {
      const fetchMock = vi.fn(async () =>
        makeResponse({ json: { choices: [{ message: { content: "x" } }] } }),
      );
      installFetch(fetchMock as unknown as FetchFn);
      const client = createLlmClient();
      await client.complete("prompt", { maxTokens: 256 });
      const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string) as {
        max_tokens: number;
      };
      expect(body.max_tokens).toBe(256);
    });
  });
});
