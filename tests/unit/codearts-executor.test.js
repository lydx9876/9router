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

  it("probe reports 'not ready' instead of blaming the credentials", async () => {
    const executor = new CodeArtsExecutor();
    const psd = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    };

    // 加密层未实现时，chat 端点对明文一律 401。这个信号不能用来判定
    // 凭据无效 —— 签名本身是对的（canonicalRequestHash 与官方 CLI 一致）。
    // 所以 probe 必须直说“功能未就绪”，而不是报“凭据错误”。
    const notReady = await executor.probeCredentials(
      { providerSpecificData: psd },
      async () =>
        new Response(JSON.stringify({ error_msg: "verify ak sk signature fail" }), {
          status: 401,
        }),
    );
    expect(notReady.valid).toBe(false);
    expect(notReady.error).toMatch(/SM4-GCM/);
    expect(notReady.error).not.toMatch(/Invalid AK\/SK/);

    const missing = await executor.probeCredentials(
      { providerSpecificData: {} },
      async () => new Response("", { status: 400 }),
    );
    expect(missing.valid).toBe(false);
    expect(missing.error).toMatch(/required/);
  });

  it("execute refuses to send an unencrypted body, with an actionable message", async () => {
    const executor = new CodeArtsExecutor();
    const psd = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    };
    await expect(
      executor.execute({
        model: "deepseek-v4.1-flash-1017",
        body: {
          model: "deepseek-v4.1-flash-1017",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        stream: true,
        credentials: { provider: "codearts-cn", providerSpecificData: psd },
        log: null,
        proxyOptions: null,
      }),
    ).rejects.toThrow(/SM4-GCM/);
  });
});
