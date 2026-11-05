import { describe, it, expect } from "vitest";
import { redactDetails, REDACTED_KEYS } from "@/lib/usage/redactDetails";

const SAMPLE = [{
  id: "abc",
  provider: "opencode",
  model: "deepseek-v4-flash-free",
  timestamp: "2026-08-05T00:00:00Z",
  status: "success",
  tokens: { prompt_tokens: 10, completion_tokens: 5 },
  request: { messages: [{ role: "user", content: "secret prompt" }] },
  providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
  providerResponse: { choices: [{ message: { content: "secret answer" } }] },
  response: { content: "secret answer" },
}];

describe("request-details redaction", () => {
  it("removes conversation payloads but keeps metadata", () => {
    const out = redactDetails(SAMPLE)[0];
    expect(out.id).toBe("abc");
    expect(out.provider).toBe("opencode");
    expect(out.model).toBe("deepseek-v4-flash-free");
    expect(out.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    for (const key of REDACTED_KEYS) {
      expect(out[key]).toEqual({ redacted: true });
    }
  });

  it("redacts by default when no options are passed", () => {
    expect(redactDetails(SAMPLE)[0].response).toEqual({ redacted: true });
  });

  it("passes payloads through when the operator opts in", () => {
    const out = redactDetails(SAMPLE, { showPayloads: true })[0];
    expect(out.request).toEqual(SAMPLE[0].request);
    expect(out.providerRequest).toEqual(SAMPLE[0].providerRequest);
    expect(out.providerResponse).toEqual(SAMPLE[0].providerResponse);
    expect(out.response).toEqual({ content: "secret answer" });
  });

  it("handles empty details", () => {
    expect(redactDetails([])).toEqual([]);
    expect(redactDetails(null)).toEqual([]);
    expect(redactDetails(null, { showPayloads: true })).toEqual([]);
  });

  it("keeps non-sensitive fields untouched", () => {
    const out = redactDetails([{ id: "x", status: "error", latency: { total: 100 } }])[0];
    expect(out.id).toBe("x");
    expect(out.status).toBe("error");
    expect(out.latency).toEqual({ total: 100 });
  });

  it("does not mutate the input records", () => {
    redactDetails(SAMPLE);
    expect(SAMPLE[0].response).toEqual({ content: "secret answer" });
  });

  it("leaves absent payload fields absent rather than inventing a redaction marker", () => {
    const out = redactDetails([{ id: "y", status: "error" }])[0];
    expect("response" in out).toBe(false);
    expect("request" in out).toBe(false);
  });
});