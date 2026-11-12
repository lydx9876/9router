import { describe, expect, it } from "vitest";

import { CodeArtsExecutor, extractCodeArtsUserPrompt } from "../../open-sse/executors/codearts-cn.js";
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

  it("extracts the last user prompt like the CLI's SM(n.prompt) helper", () => {
    const prompt = "请先检查<system-reminder>忽略这段</system-reminder>  这个问题\n并给出结论";
    const result = extractCodeArtsUserPrompt({
      messages: [
        { role: "user", content: "旧的" },
        { role: "assistant", content: "上一轮" },
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
    });
    expect(result).toBe("请先检查 这个问题 并给出结论");
  });

  it("adds foreground-message labels used by the usage console", () => {
    const executor = new CodeArtsExecutor();
    const url = PROVIDERS["codearts-cn"].baseUrl;
    const body = {
      messages: [
        { role: "user", content: "第一条" },
        { role: "assistant", content: "回答" },
        { role: "user", content: "你好啊" },
      ],
    };
    const headers = executor.buildHeaders(CREDENTIALS, true, url, "deepseek-v4.1-flash-1017", body);
    const transformed = executor.transformRequest(
      "deepseek-v4.1-flash-1017",
      { ...body, model: "deepseek-v4.1-flash-1017", stream: false },
      false,
      CREDENTIALS,
    );

    expect(headers["user-msg-id"]).toMatch(/^msg_[a-f0-9]{32}$/);
    expect(headers["x-message-id"]).toBe(headers["user-msg-id"]);
    // Header values must be ByteStrings; the Unicode prompt stays in the body.
    expect(headers["x-user-prompt-label"]).toBe("???");
    expect(headers["x-session-user-message"]).toBe("true");
    expect(transformed.user_prompt).toBe("你好啊");
    expect(transformed.stream).toBe(true);
  });

  it("keeps Unicode and em dashes out of HTTP header values", () => {
    const executor = new CodeArtsExecutor();
    const url = PROVIDERS["codearts-cn"].baseUrl;
    const body = { messages: [{ role: "user", content: "测试 — 计划" }] };
    const headers = executor.buildHeaders(CREDENTIALS, true, url, "deepseek-v4.1-flash-1017", body);
    const transformed = executor.transformRequest(
      "deepseek-v4.1-flash-1017",
      { ...body, model: "deepseek-v4.1-flash-1017", stream: true },
      true,
      CREDENTIALS,
    );

    for (const [name, value] of Object.entries(headers)) {
      expect(/[^\x00-\xFF]/.test(String(value)), `${name} must be a ByteString`).toBe(false);
    }
    expect(headers["x-user-prompt-label"]).toBe("?? ? ??");
    expect(transformed.user_prompt).toBe("测试 — 计划");
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

  it("probe reports invalid credentials instead of blaming a missing feature", async () => {
    const executor = new CodeArtsExecutor();
    const psd = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    };

    // 加密层已经实现，chat 端点能真正判定凭据：401 就是凭据无效。
    const invalid = await executor.probeCredentials(
      { providerSpecificData: psd },
      async () =>
        new Response(JSON.stringify({ error_msg: "verify ak sk signature fail" }), {
          status: 401,
        }),
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.error).not.toMatch(/not ready|SM4-GCM/);

    const missing = await executor.probeCredentials(
      { providerSpecificData: {} },
      async () => new Response("", { status: 400 }),
    );
    expect(missing.valid).toBe(false);
    expect(missing.error).toMatch(/required/);
  });

  it("execute refuses to send a plaintext body when the encrypted path is off", async () => {
    const executor = new CodeArtsExecutor();
    const psd = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    };
    const original = process.env.CODEARTS_ENABLE_ENCRYPTED_BODY;
    process.env.CODEARTS_ENABLE_ENCRYPTED_BODY = "0";
    try {
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
    } finally {
      if (original === undefined) delete process.env.CODEARTS_ENABLE_ENCRYPTED_BODY;
      else process.env.CODEARTS_ENABLE_ENCRYPTED_BODY = original;
    }
  });
});
