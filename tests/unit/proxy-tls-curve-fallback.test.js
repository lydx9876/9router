import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The pinned single-curve ClientHello (`ecdhCurve: "X25519"`) exists to slip past
 * ISP DPI on some networks, but an edge that dropped X25519 answers with a fatal
 * alert 40. These tests pin down the recovery: demote that host to the default
 * curve list and retry, without touching other hosts or replaying ambiguous errors.
 */
describe("pinned TLS curve fallback", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.NINEROUTER_TLS_ECDH_CURVE;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.doUnmock("undici");
  });

  const handshakeFailure = () =>
    Object.assign(new Error("fetch failed"), {
      cause: {
        code: "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE",
        message:
          "0A000410:SSL routines:ssl3_read_bytes:ssl/tls alert handshake failure:../deps/openssl/ssl/record/rec_layer_s3.c:918:SSL alert number 40",
      },
    });

  const mockFetch = (impl) =>
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: vi.fn(impl) };
    });

  it("retries once with the default curve list when the edge rejects the pinned list", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(handshakeFailure()).mockResolvedValueOnce({ status: 200, ok: true });
    mockFetch(fetchMock);

    const { proxyAwareFetch, getDirectDispatcher, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    const res = await proxyAwareFetch("https://ai.gitee.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bge-m3", input: "hi" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The body is carried over verbatim on the retry, and the dispatcher changed.
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(await getDirectDispatcher(false, true));
    expect(fetchMock.mock.calls[1][1].dispatcher).toBe(await getDirectDispatcher(false, false));
  });

  it("remembers the demotion per host so later requests skip the doomed handshake", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(handshakeFailure())
      .mockResolvedValue({ status: 200, ok: true });
    mockFetch(fetchMock);

    const { proxyAwareFetch, getDirectDispatcher, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    await proxyAwareFetch("https://ai.gitee.com/v1/models");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await proxyAwareFetch("https://ai.gitee.com/v1/models");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Second request goes straight out on the default-curve agent.
    expect(fetchMock.mock.calls[2][1].dispatcher).toBe(await getDirectDispatcher(false, false));
  });

  it("keeps the pinned curve for other hosts after one host is demoted", async () => {
    const fetchMock = vi.fn().mockImplementation((url) =>
      String(url).includes("gitee")
        ? Promise.reject(handshakeFailure())
        : Promise.resolve({ status: 200, ok: true })
    );
    mockFetch(fetchMock);

    const { proxyAwareFetch, getDirectDispatcher, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    await expect(proxyAwareFetch("https://ai.gitee.com/v1/models")).rejects.toThrow(/fetch failed/);
    await proxyAwareFetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });

    const anthropicCall = fetchMock.mock.calls.at(-1);
    expect(String(anthropicCall[0])).toContain("anthropic");
    expect(anthropicCall[1].dispatcher).toBe(await getDirectDispatcher(false, true));
  });

  it("does not replay a handshake failure that is not an alert 40", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: { code: "ERR_SSL_WRONG_VERSION_NUMBER", message: "wrong version number" },
      })
    );
    mockFetch(fetchMock);

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await expect(proxyAwareFetch("https://ai.gitee.com/v1/models")).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors NINEROUTER_TLS_ECDH_CURVE=off by using the default curve list from the start", async () => {
    process.env.NINEROUTER_TLS_ECDH_CURVE = "off";
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    mockFetch(fetchMock);

    const { proxyAwareFetch, getDirectDispatcher, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    await proxyAwareFetch("https://ai.gitee.com/v1/models");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(await getDirectDispatcher(false, false));
  });
});
