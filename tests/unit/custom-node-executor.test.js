import { describe, it, expect } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { CustomNodeExecutor } from "../../open-sse/executors/customNode.js";

/**
 * A `custom-embedding-*` or `custom-rerank-*` node carries its URL in the
 * connection, not in a registry entry.
 *
 * Without a dedicated executor, DefaultExecutor fell back to its own baseUrl —
 * api.openai.com — so a chat request aimed at a custom node was posted to
 * OpenAI along with the user's API key, and came back as a confusing
 * "Incorrect API key provided" for a key the user never entered there.
 */
describe("custom node executor", () => {
  it("uses the dedicated executor for custom node providers", () => {
    const embed = getExecutor("custom-embedding-5cbc5d84-2134-4433-a9c4-15e7cf3d33b7");
    const rerank = getExecutor("custom-rerank-05353cfe-fd4a-45af-907d-0729f88fc4c1");
    expect(embed).toBeInstanceOf(CustomNodeExecutor);
    expect(rerank).toBeInstanceOf(CustomNodeExecutor);
  });

  it("never falls back to api.openai.com", () => {
    const provider = "custom-embedding-5cbc5d84-2134-4433-a9c4-15e7cf3d33b7";
    const ex = getExecutor(provider);
    expect(() => ex.buildUrl("m", true, 0, { providerSpecificData: {} })).toThrow(/no base URL/i);
    expect(() => ex.buildUrl("m", true, 0, { providerSpecificData: {} })).not.toThrow(/openai/i);
  });

  it("routes a rerank node to /rerank on the configured host", () => {
    const ex = getExecutor("custom-rerank-abc");
    const url = ex.buildUrl("m", true, 0, {
      providerSpecificData: { baseUrl: "https://ai.gitee.com/v1" },
    });
    expect(url).toBe("https://ai.gitee.com/v1/rerank");
  });

  it("tolerates a base URL that already carries the path", () => {
    const ex = getExecutor("custom-rerank-abc");
    expect(
      ex.buildUrl("m", true, 0, { providerSpecificData: { baseUrl: "https://ai.gitee.com/v1/rerank" } }),
    ).toBe("https://ai.gitee.com/v1/rerank");
    expect(
      ex.buildUrl("m", true, 0, { providerSpecificData: { baseUrl: "https://ai.gitee.com/v1/" } }),
    ).toBe("https://ai.gitee.com/v1/rerank");
  });

  it("refuses to serve chat requests from an embedding node", () => {
    const ex = getExecutor("custom-embedding-abc");
    expect(() =>
      ex.buildUrl("m", true, 0, { providerSpecificData: { baseUrl: "https://ai.gitee.com/v1" } }),
    ).toThrow(/embedding node/i);
  });

  it("sends the API key when one is configured", () => {
    const ex = getExecutor("custom-rerank-abc");
    const headers = ex.buildHeaders(
      { apiKey: "sk-test", providerSpecificData: { baseUrl: "https://x/v1" } },
      true,
      "https://x/v1/rerank",
      "m",
      {},
    );
    expect(headers.Authorization).toBe("Bearer sk-test");
  });
});
