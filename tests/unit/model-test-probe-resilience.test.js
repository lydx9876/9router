import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => [{ key: "test-key", isActive: true }]) }));
vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "cli-token") }));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");

/**
 * A probe must always resolve to a per-model result.
 *
 * Two failures this pins down, both seen on a live qoder-cn account:
 *  1. `fetch` rejects on abort/DNS/refused connection. That reject used to escape
 *     pingModelByKind and propagate into the caller's `Promise.all`, so the route
 *     answered a bare 500 "Test failed" instead of saying which model broke.
 *  2. Every kind shared a 15s budget. qoder answers "model queued, retry in Ns" and
 *     the same model served fine once the queue drained, so 15s manufactured a
 *     timeout failure on a healthy credential.
 */
describe("pingModelByKind resilience", () => {
  let fetchMock;
  let timeoutSpy;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function ok(body) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }

  it.each([
    ["aborted probe", () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
    ["refused connection", () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })],
    ["dns failure", () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })],
  ])("returns a result object instead of throwing on %s", async (_label, makeError) => {
    fetchMock.mockRejectedValue(makeError());

    const result = await pingModelByKind("qdcn/gfmodel", "llm", "http://127.0.0.1:20127");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("marks a probe timeout as a timeout rather than an opaque fetch error", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));

    const result = await pingModelByKind("qdcn/gfmodel", "llm", "http://127.0.0.1:20127");

    expect(result.error).toMatch(/timed out/i);
  });

  it("keeps one short budget for every provider, queued or not", async () => {
    // A raised budget for queued providers was tried and reverted: qoder holds the
    // queue for minutes, so a 240s cap made a 14-model sweep take 662s and still
    // failed every queued model. A probe answers "can it serve now".
    fetchMock.mockResolvedValue(ok({ choices: [{ message: { content: "hi" } }] }));

    await pingModelByKind("qdcn/gfmodel", "llm", "http://127.0.0.1:20127");
    await pingModelByKind("openai/gpt-4o", "llm", "http://127.0.0.1:20127");
    await pingModelByKind("openai/gpt-4o", "embedding", "http://127.0.0.1:20127");

    expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([15_000, 15_000, 15_000]);
  });

  it("reports a queued model as queued instead of a plain failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 504,
      text: async () => JSON.stringify({ error: { message: `{"code":"504","message":"Queue wait timed out"}` } }),
    });

    const result = await pingModelByKind("qdcn/gfmodel", "llm", "http://127.0.0.1:20127");

    expect(result.ok).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.error).toMatch(/queued upstream/i);
  });

  it("does not call an ordinary failure queued", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'qoder: model_config for "x" not yet known' } }),
    });

    const result = await pingModelByKind("qdcn/gfmodel", "llm", "http://127.0.0.1:20127");

    expect(result.ok).toBe(false);
    expect(result.queued).toBeUndefined();
  });

  it("does not mark queue wording from a non-qoder provider as queued", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: { message: "Queue wait timed out" } }),
    });

    const result = await pingModelByKind("openai/gpt-4o", "llm", "http://127.0.0.1:20127");

    expect(result.queued).toBeUndefined();
  });

  it("still reports a genuine provider error with its status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: "quota exhausted" } }),
    });

    const result = await pingModelByKind("qdcn/gfmodel", "llm", "http://127.0.0.1:20127");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("quota exhausted");
  });
});
