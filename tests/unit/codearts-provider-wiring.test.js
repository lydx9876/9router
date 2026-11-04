import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";

/**
 * 码道（华为云 CodeArts Doer）接入 9router 的链路校验：
 *   客户端模型名 "cdc/<model>" → provider "codearts-cn" → IAM 签名 → snap-access 网关
 *
 * 这些断言锁住三件容易悄悄坏掉的事：
 *  1. alias "cdc" 能解析到 provider id（否则请求会 404 "No active credentials"）；
 *  2. 注册表里的模型列表用的是**裸模型名**，不带 "cdc/" 前缀（否则转发给上游会拼成
 *     "cdc/cdc/deepseek-..."，上游直接 400）；
 *  3. 运行时拿到的是专属 executor，而不是退化成 DefaultExecutor 的 Bearer 头。
 */
const ENTRY = REGISTRY.find((r) => r.id === "codearts-cn");

describe("codearts-cn provider wiring", () => {
  it("resolves the 'cdc' alias to the codearts-cn provider", () => {
    expect(ENTRY).toBeTruthy();
    expect(ENTRY.alias).toBe("cdc");
    expect(ENTRY.uiAlias).toBe("cdc");
  });

  it("registers under the apikey category so the UI offers it", () => {
    expect(ENTRY.category).toBe("apikey");
    expect(ENTRY.credentialForm).toBe("codearts");
    expect(ENTRY.apiKeyOptionalWith).toBe("accessKeyId");
  });

  it("lists models under the alias key with bare model ids", () => {
    const models = PROVIDER_MODELS["cdc"];
    expect(models).toBeTruthy();
    expect(models.length).toBeGreaterThan(0);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("deepseek-v4.1-flash-1017");
    // A prefixed id would break the upstream request URL.
    expect(ids.every((id) => !id.startsWith("cdc/"))).toBe(true);
    expect(ids.every((id) => !id.includes("/"))).toBe(true);
  });

  it("points at the snap-access chat completions endpoint", () => {
    expect(PROVIDERS["codearts-cn"].baseUrl).toBe(
      "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions",
    );
    expect(PROVIDERS["codearts-cn"].forceStream).toBe(true);
  });

  it("uses the dedicated executor at runtime (not the Bearer default)", () => {
    const executor = getExecutor("codearts-cn");
    expect(executor.constructor.name).toBe("CodeArtsExecutor");

    // The default executor would emit a Bearer header the CodeArts gateway rejects.
    const headers = executor.buildHeaders(
      {
        provider: "codearts-cn",
        providerSpecificData: {
          accessKeyId: "AKTEST",
          secretAccessKey: "SKTEST",
        },
      },
      true,
      PROVIDERS["codearts-cn"].baseUrl,
      "deepseek-v4.1-flash-1017",
      {},
    );
    expect(headers["Authorization"]).toMatch(/^SDK-HMAC-SHA256 Access=AKTEST,/);
    expect(headers["Authorization"]).not.toContain("Bearer");
  });
});
