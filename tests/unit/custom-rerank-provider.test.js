import { describe, it, expect } from "vitest";
import {
  isCustomRerankProvider,
  isCustomEmbeddingProvider,
  CUSTOM_RERANK_PREFIX,
  CUSTOM_EMBEDDING_PREFIX,
  MEDIA_PROVIDER_KINDS,
} from "../../src/shared/constants/providers";

describe("custom rerank provider constants", () => {
  it("recognizes custom-rerank provider ids", () => {
    expect(isCustomRerankProvider(`${CUSTOM_RERANK_PREFIX}abc123`)).toBe(true);
    expect(isCustomRerankProvider("custom-rerank-2c4164f4-d6af-411b-a2f8-d3f8a9ea7f28")).toBe(true);
  });

  it("does not claim other providers", () => {
    expect(isCustomRerankProvider("openai")).toBe(false);
    expect(isCustomRerankProvider(`${CUSTOM_EMBEDDING_PREFIX}abc`)).toBe(false);
    expect(isCustomRerankProvider("")).toBe(false);
    expect(isCustomRerankProvider(undefined)).toBe(false);
  });

  it("keeps the embedding and rerank prefixes distinct", () => {
    expect(CUSTOM_RERANK_PREFIX).not.toBe(CUSTOM_EMBEDDING_PREFIX);
  });

  it("exposes rerank as a media provider kind with its endpoint", () => {
    const kind = MEDIA_PROVIDER_KINDS.find((k) => k.id === "rerank");
    expect(kind).toBeTruthy();
    expect(kind.endpoint).toEqual({ method: "POST", path: "/v1/rerank" });
    expect(kind.label).toBe("Rerank");
  });
});
