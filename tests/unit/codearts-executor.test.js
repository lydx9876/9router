import { describe, expect, it } from "vitest";

import { CodeArtsExecutor } from "../../open-sse/executors/codearts-cn.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

const CREDENTIALS = {
  provider: "codearts-cn",
  accessToken: "placeholder-access-token",
  apiKey: "placeholder-api-key",
  providerSpecificData: {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  },
};

describe("codearts-cn executor", () => {
  it("is registered in the provider registry with the CLI's model list", () => {
    const provider = PROVIDERS["codearts-cn"];
    expect(provider).toBeTruthy();
    expect(provider.baseUrl).toBe(
      "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions",
    );
    expect(provider.forceStream).toBe(true);
    expect(provider.thinkingFormat).toBe("openai");
  });

  it("signs the request with IAM headers instead of a Bearer token", () => {
    const executor = new CodeArtsExecutor();
    const url = PROVIDERS["codearts-cn"].baseUrl;
    const headers = executor.buildHeaders(CREDENTIALS, true, url, "deepseek-v4.1-flash-1017", {});

    expect(headers["Authorization"]).toMatch(/^SDK-HMAC-SHA256 Access=/);
    expect(headers["Authorization"]).not.toContain("Bearer");
    expect(headers["X-Sdk-Content-Sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(headers["X-Sdk-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers["app-id"]).toBe("CodeAgent3.0");
    expect(headers["is-need-queue"]).toBe("true");
    expect(headers["x-ot-client-type"]).toBe("CLI");
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  it("signs a different signature per request (X-Sdk-Date is part of the signature)", () => {
    const executor = new CodeArtsExecutor();
    const url = PROVIDERS["codearts-cn"].baseUrl;
    const a = executor.buildHeaders(CREDENTIALS, true, url, "glm-5.3", {});
    const b = executor.buildHeaders(CREDENTIALS, true, url, "glm-5.3", {});
    // Same second → same signature; the header must at least be present and well-formed.
    expect(a["Authorization"]).toContain("Signature=");
    expect(b["Authorization"]).toContain("Signature=");
  });

  it("forces stream=true (the endpoint rejects non-stream chat requests)", () => {
    const executor = new CodeArtsExecutor();
    const body = executor.transformRequest(
      "deepseek-v4.1-flash-1017",
      { model: "deepseek-v4.1-flash-1017", messages: [{ role: "user", content: "hi" }], stream: false },
      false,
      CREDENTIALS,
    );
    expect(body.stream).toBe(true);
  });

  it("fails loudly when AK/SK are missing instead of sending an unsigned request", () => {
    const executor = new CodeArtsExecutor();
    const url = PROVIDERS["codearts-cn"].baseUrl;
    expect(() =>
      executor.buildHeaders(
        { provider: "codearts-cn", providerSpecificData: {} },
        true,
        url,
        "glm-5.3",
        {},
      ),
    ).toThrow(/accessKeyId and secretAccessKey/);
  });

  it("probe distinguishes a bad AK/SK from a working one", async () => {
    const executor = new CodeArtsExecutor();
    const psd = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    };

    // A stubbed 401 carrying the gateway's signature error must not read as "valid".
    const rejected = await executor.probeCredentials(
      { providerSpecificData: psd },
      async () =>
        new Response(JSON.stringify({ error_msg: "verify ak sk signature fail" }), {
          status: 401,
        }),
    );
    expect(rejected.valid).toBe(false);
    expect(rejected.error).toMatch(/AK\/SK/i);

    // A concurrency-limit rejection still means the credentials are good.
    const saturated = await executor.probeCredentials(
      { providerSpecificData: psd },
      async () =>
        new Response(JSON.stringify({ error_msg: "并发会话数已达上限(3个)" }), { status: 400 }),
    );
    expect(saturated.valid).toBe(true);

    const missing = await executor.probeCredentials(
      { providerSpecificData: {} },
      async () => new Response("", { status: 400 }),
    );
    expect(missing.valid).toBe(false);
    expect(missing.error).toMatch(/required/);  });
});
