import { describe, it, expect } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

/**
 * 这些 provider 有自己的 executor，buildUrl / buildHeaders 与 DefaultExecutor
 * 不同 —— golden-url-header.test.js 里的 SPECIALIZED 集合把它们排除了
 * （那个测试用 `new DefaultExecutor(pid)` 构造，测的不是真实行为）。
 *
 * 所以这里补一份离线覆盖，把它们从 golden 里移走的断言补回来。
 */
const CUSTOM_EXECUTOR_PROVIDERS = [
  "codearts-cn",
  "codebuddy-cn",
  "codebuddy-intl",
  "minimax-code",
  "minimax-code-global",
];

describe("providers with a custom executor", () => {
  it.each(CUSTOM_EXECUTOR_PROVIDERS)("%s resolves to its own endpoint", (pid) => {
    const ex = getExecutor(pid);
    const url = ex.buildUrl("test-model", true, 0, { providerSpecificData: {} });
    expect(url).toBe(PROVIDERS[pid].baseUrl);
    // 流式与非流式同端点（码道是 SSE-only）
    expect(ex.buildUrl("test-model", false, 0, { providerSpecificData: {} })).toBe(url);
  });

  it.each(CUSTOM_EXECUTOR_PROVIDERS)("%s builds headers without throwing", (pid) => {
    const ex = getExecutor(pid);
    const headers = ex.buildHeaders(
      { provider: pid, providerSpecificData: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" } },
      true,
      PROVIDERS[pid].baseUrl,
      "test-model",
      {},
    );
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("codearts-cn signs with IAM and keeps the CLI headers", () => {
    const ex = getExecutor("codearts-cn");
    const headers = ex.buildHeaders(
      {
        provider: "codearts-cn",
        providerSpecificData: {
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        },
      },
      true,
      PROVIDERS["codearts-cn"].baseUrl,
      "deepseek-v4.1-flash-1017",
      {},
    );

    expect(headers.Authorization).toMatch(/^SDK-HMAC-SHA256 Access=/);
    expect(headers["X-Sdk-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
    // registry 里的固定 CLI 头
    expect(headers["app-id"]).toBe("CodeAgent3.0");
    expect(headers["x-ot-client-type"]).toBe("CLI");
    // 每请求变化的头由 executor 生成
    expect(headers["x-ot-trace-id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["x-ot-session-id"]).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  it("codebuddy-cn keeps its CLI channel headers", () => {
    const ex = getExecutor("codebuddy-cn");
    const headers = ex.buildHeaders(
      { provider: "codebuddy-cn", providerSpecificData: {}, apiKey: "sk-test" },
      true,
      PROVIDERS["codebuddy-cn"].baseUrl,
      "test-model",
      {},
    );
    expect(headers["x-codebuddy-request"]).toBe("1");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
  });
});
