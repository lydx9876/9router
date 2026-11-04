import { describe, expect, it } from "vitest";

import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

/**
 * 码道接入 9router 的完整链路验证（真实网络请求）。
 *
 * 模拟 getProviderCredentials() → executor → snap-access 网关 → SSE 聚合，
 * 确认凭据能从 connection 的 providerSpecificData 一路走到上游并拿到回答。
 *
 * ⚠️ 目前 chat 请求是禁用的（上游要求 body 经 SM4-GCM 加密，未实现），
 * 所以这个测试默认跳过。加密层落地后，把 CODEARTS_ENABLE_ENCRYPTED_BODY=1
 * 传上即可真正跑起来。
 *
 * 凭据来自环境变量 CODEARTS_AK / CODEARTS_SK；未设置时跳过（避免把密钥写进仓库）。
 */
const AK = process.env.CODEARTS_AK;
const SK = process.env.CODEARTS_SK;
const ENCRYPTED = process.env.CODEARTS_ENABLE_ENCRYPTED_BODY === "1";
const hasCreds = !!(AK && SK && ENCRYPTED);

describe("codearts-cn end-to-end", () => {
  it.skipIf(!hasCreds)("signs with AK/SK and gets an answer from the CodeArts gateway", async () => {
    const provider = "codearts-cn";
    const model = "deepseek-v4.1-flash-1017";
    const ex = getExecutor(provider);
    expect(ex.constructor.name).toBe("CodeArtsExecutor");

    // getProviderCredentials() 返回的形状：凭据只在 providerSpecificData 里。
    const credentials = {
      authType: "apikey",
      providerSpecificData: { accessKeyId: AK, secretAccessKey: SK },
      connectionId: "test-conn",
    };

    const url = ex.buildUrl(model, true, 0, credentials);
    expect(url).toBe(PROVIDERS[provider].baseUrl);

    const body = ex.transformRequest(
      model,
      { model, messages: [{ role: "user", content: "用一句话说明什么是 IIFE" }], stream: true },
      true,
      credentials,
    );
    expect(body.stream).toBe(true);

    // 走完整的加密链路：key-exchange → SM4-GCM → 重新签名 → 上游 → 解密 SSE
    const result = await ex.execute({
      model,
      body,
      stream: true,
      credentials,
      log: { debug: () => {}, error: () => {} },
    });
    expect(result.response.status).toBe(200);

    const text = await result.response.text();
    let content = "";
    let usage = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const d = JSON.parse(raw);
        if (d.choices?.[0]?.delta?.content) content += d.choices[0].delta.content;
        if (d.usage) usage = d.usage;
      } catch { /* keep-alive frame */ }
    }
    expect(content.length).toBeGreaterThan(0);
    expect(usage?.total_tokens).toBeGreaterThan(0);
  }, 60000);
});
