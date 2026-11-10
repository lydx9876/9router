import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

/**
 * A provider that answers "model queued, retry in Ns" is working — it has no
 * capacity for that model yet. It must never be treated as a credential fault,
 * because the dashboard reads that state as "this account is down".
 *
 * Real failure this pins down: one model-test click on qoder-cn fell through to
 * the generic transient cooldown, wrote modelLock_<model> for every probe, and
 * left testStatus:"unavailable" on a connection whose 400 credits were untouched.
 */
describe("qoder model-queue throttle is request-scoped", () => {
  const queueMessages = [
    `[qoder-cn/auto] [504]: {"error":{"message":"{\\"code\\":\\"504\\",\\"message\\":\\"Queue wait timed out\\"}","code":504}}`,
    `{"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"gfmodel\\"}"}`,
    `queue wait timed out after 600s (queueType=p4)`,
  ];

  it.each(queueMessages)("does not cool the account down or lock the model: %s", (message) => {
    for (const status of [503, 504, 400]) {
      const result = checkFallbackError(status, message, 0, "qoder-cn");
      expect(result.shouldFallback).toBe(false);
      expect(result.cooldownMs).toBe(0);
      // Combo rotation may still advance to the next member.
      expect(result.requestScoped).toBe(true);
    }
  });

  it("applies to the intl qoder provider too", () => {
    const result = checkFallbackError(503, "queue wait timed out", 0, "qoder");
    expect(result).toMatchObject({ shouldFallback: false, requestScoped: true });
  });

  it("does not affect other providers that happen to use the same wording", () => {
    const result = checkFallbackError(503, "queue wait timed out", 0, "openai");
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("still locks the account on a real qoder quota block (code 112)", () => {
    const result = checkFallbackError(
      403,
      `{"error":{"message":"{\\"code\\":\\"112\\",\\"message\\":\\"{\\\\\\"pricingUrl\\\\\\":\\\\\\"https://qoder.com.cn/pricing?client=qoder\\\\\\"}\\"}","code":403}}`,
      0,
      "qoder-cn",
    );
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
});
