import { describe, it, expect } from "vitest";
import { getRerankAdapter } from "../../open-sse/handlers/rerankProviders/index.js";
import customRerank from "../../open-sse/handlers/rerankProviders/customRerank.js";
import { handleRerankCore } from "../../open-sse/handlers/rerankCore.js";

const credentials = {
  apiKey: "sk-test",
  providerSpecificData: { baseUrl: "http://localhost:8080/v1" },
};

describe("rerank adapter registry", () => {
  it("resolves custom-rerank nodes", () => {
    expect(getRerankAdapter("custom-rerank-abc123")).toBe(customRerank);
    expect(getRerankAdapter("custom-rerank-2c4164f4-d6af-411b-a2f8-d3f8a9ea7f28")).toBe(customRerank);
  });

  it("does not claim other providers", () => {
    expect(getRerankAdapter("openai")).toBeNull();
    expect(getRerankAdapter("custom-embedding-x")).toBeNull();
    expect(getRerankAdapter("cohere")).toBeNull();
    // A bare "custom-rerank" is not a node id — node ids carry a uuid suffix.
    expect(getRerankAdapter("custom-rerank")).toBeNull();
  });
});

describe("custom rerank adapter", () => {
  it("appends /rerank to the configured base URL", () => {
    expect(customRerank.buildUrl("m", credentials)).toBe("http://localhost:8080/v1/rerank");
  });

  it("tolerates a trailing slash and a pasted /rerank endpoint", () => {
    const slashed = { providerSpecificData: { baseUrl: "http://host:9000/v1/" } };
    expect(customRerank.buildUrl("m", slashed)).toBe("http://host:9000/v1/rerank");

    const full = { providerSpecificData: { baseUrl: "http://host:9000/v1/rerank" } };
    expect(customRerank.buildUrl("m", full)).toBe("http://host:9000/v1/rerank");
  });

  it("sends the API key when one is configured", () => {
    const headers = customRerank.buildHeaders(credentials);
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("omits the Authorization header when no key is set", () => {
    const headers = customRerank.buildHeaders({ providerSpecificData: {} });
    expect(headers.Authorization).toBeUndefined();
  });

  it("builds the request body with query, documents and top_n", () => {
    const body = customRerank.buildBody("m", {
      query: "what is a closure",
      documents: ["a", "b", "c"],
      top_n: 2,
    });
    expect(body).toEqual({
      model: "m",
      query: "what is a closure",
      documents: ["a", "b", "c"],
      top_n: 2,
    });
  });

  it("drops an invalid top_n", () => {
    const body = customRerank.buildBody("m", {
      query: "q",
      documents: ["a"],
      top_n: "not-a-number",
    });
    expect(body.top_n).toBeUndefined();
  });
});

describe("custom rerank normalize", () => {
  it("keeps the upstream index and relevance_score", () => {
    const out = customRerank.normalize(
      { id: "r1", results: [{ index: 2, relevance_score: 0.87 }, { index: 0, relevance_score: 0.98 }] },
      "m",
    );
    expect(out.id).toBe("r1");
    expect(out.results).toEqual([
      { index: 0, relevance_score: 0.98 },
      { index: 2, relevance_score: 0.87 },
    ]);
  });

  it("sorts by score descending", () => {
    const out = customRerank.normalize(
      { results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] },
      "m",
    );
    expect(out.results.map((r) => r.index)).toEqual([1, 0]);
  });

  it("falls back to the position when the server omits the index", () => {
    const out = customRerank.normalize(
      { results: [{ relevance_score: 0.5 }, { relevance_score: 0.6 }] },
      "m",
    );
    expect(out.results.map((r) => r.index)).toEqual([1, 0]);
  });

  it("accepts alternative score field names", () => {
    const out = customRerank.normalize({ results: [{ index: 0, score: 0.42 }] }, "m");
    expect(out.results[0].relevance_score).toBe(0.42);
  });

  it("attaches the document text when the server does not echo it", () => {
    const documents = ["doc zero", "doc one"];
    const out = customRerank.normalize({ results: [{ index: 1, relevance_score: 0.9 }] }, "m", { documents });
    expect(out.results[0].document).toBe("doc one");
  });

  it("survives a malformed response", () => {
    const out = customRerank.normalize({}, "m");
    expect(out.results).toEqual([]);
  });
});

describe("handleRerankCore", () => {
  const baseArgs = {
    modelInfo: { provider: "custom-rerank-x", model: "m" },
    credentials,
    log: { debug: () => {} },
  };

  it("rejects a missing query", async () => {
    const result = await handleRerankCore({ ...baseArgs, body: { documents: ["a"] } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/query/);
  });

  it("rejects empty documents", async () => {
    const result = await handleRerankCore({ ...baseArgs, body: { query: "q", documents: [] } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/documents/);
  });

  it("rejects non-string documents", async () => {
    const result = await handleRerankCore({ ...baseArgs, body: { query: "q", documents: [1, 2] } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/documents/);
  });

  it("rejects a provider that does not support rerank", async () => {
    const result = await handleRerankCore({
      ...baseArgs,
      modelInfo: { provider: "openai", model: "m" },
      body: { query: "q", documents: ["a"] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not support rerank/);
  });

  it("returns a normalized result and no usage", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ id: "r1", results: [{ index: 1, relevance_score: 0.9 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    try {
      const result = await handleRerankCore({
        ...baseArgs,
        body: { query: "q", documents: ["zero", "one"] },
      });
      expect(result.success).toBe(true);
      // Rerank carries no token counts — nothing to bill.
      expect(result.usage).toBeNull();

      const payload = await result.response.json();
      expect(payload.results[0]).toMatchObject({ index: 1, relevance_score: 0.9 });
      expect(payload.results[0].document).toBe("one");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces an upstream error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error_msg: "model not found" }), { status: 400 });
    try {
      const result = await handleRerankCore({
        ...baseArgs,
        body: { query: "q", documents: ["a"] },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/model not found/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
