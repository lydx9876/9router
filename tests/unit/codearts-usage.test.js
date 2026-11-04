import { afterEach, describe, expect, it, vi } from "vitest";

// proxyAwareFetch 捕获了模块加载时的 globalThis.fetch，stubGlobal 拦不住，
// 所以直接 mock 整个模块，只保留 proxyOptions 透传。
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { getCodeArtsUsage } = await import("../../open-sse/services/usage/codearts-cn.js");
const { parseQuotaData } = await import(
  "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
);

/**
 * 码道配额跟踪的回归测试。
 *
 * 锁住三件容易悄悄坏掉的事：
 *  1. AK/SK 缺失时不发请求、直接报错（而不是拿空凭据去签名）；
 *  2. 积分包的 used/total 映射正确，且**不编造过期时间**（resetAt 恒为 null）；
 *  3. 积分套餐下 usageTokenChatMessages 的 package_token_amount 恒为 1，
 *     把它当"已用/总量"会显示成 537419/1 的荒谬比例 —— 必须跳过。
 */

// 真实响应快照（2026-11-04 实测，AK/SK 签名调用 statistics/plugin）。
// 注意 package_token_amount: 1 —— 这是"1 个 token 包"（实质不限量）的编码，
// 不是"包内只有 1 个 token"。
const STATS_RESPONSE = {
  metrics: [
    { name: "usageDataChatMessages", value: -1, usage_token_num: 0, package_token_amount: 0, show: false },
    { name: "usageTokenChatMessages", value: 0, usage_token_num: 537419, package_token_amount: 1, show: true },
    {
      name: "usageTotalPackageCredit",
      value: 0,
      usage_token_num: 0,
      package_token_amount: 0,
      package_credit_amount: 4600,
      package_credit_used: 0.26,
      package_credit_remain: 4599.74,
      package_credit_expiring_amount: 99.74,
      show: true,
    },
    {
      name: "usageBasicPackageCredit",
      value: 0,
      package_credit_amount: 500,
      package_credit_used: 0,
      package_credit_remain: 500,
      show: true,
    },
    {
      name: "usageOnDemandPackageCredit",
      value: 0,
      package_credit_amount: 0,
      package_credit_used: 0,
      package_credit_remain: 0,
      show: true,
    },
    {
      name: "usageBonusPackageCredit",
      value: 0,
      package_credit_amount: 4100,
      package_credit_used: 0.26,
      package_credit_remain: 4099.74,
      package_credit_expiring_amount: 99.74,
      show: true,
    },
  ],
  model_metrics: [],
  // end_date 是失效日（exclusive）：有效区间 [2026-11-02, 2026-12-03)，
  // 即最后有效日 2026-12-02 23:59 —— 与控制台「套餐及积分包」显示的一致。
  start_date: "2026-11-02",
  end_date: "2026-12-03",
  package: {
    spec_code: "codearts.agent.individual.trial",
    status: "normal",
    package_name_en: "Trial",
    package_name_cn: "体验版",
    is_token_package: false,
    is_credit_package: true,
  },
  show: { package: true, metrics: true },
  is_white_list: false,
};

/** 用假 fetch 把 STATS_RESPONSE 喂给 handler。 */
function stubFetch(payload, status = 200) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  return fetchMock;
}

const PSD = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

afterEach(() => {
  fetchMock.mockReset();
});

describe("getCodeArtsUsage", () => {
  it("maps the credit packages into used/total rows", async () => {
    stubFetch(STATS_RESPONSE);
    const result = await getCodeArtsUsage(PSD);

    expect(result.plan).toBe("体验版");
    expect(result.quotas["Total Credits"]).toMatchObject({ used: 0.26, total: 4600 });
    expect(result.quotas["Basic Package"]).toMatchObject({ used: 0, total: 500 });
    expect(result.quotas["Bonus Package"]).toMatchObject({ used: 0.26, total: 4100 });
  });

  it("omits the token package when package_token_amount is 1 (not a real quota)", async () => {
    stubFetch(STATS_RESPONSE);
    const result = await getCodeArtsUsage(PSD);
    // 537419 used / 1 total would render as an absurd 53741900% bar.
    expect(result.quotas["Token Package"]).toBeUndefined();
  });

  it("surfaces a token package when the amount really is a token count", async () => {
    const payload = {
      ...STATS_RESPONSE,
      metrics: STATS_RESPONSE.metrics.map((m) =>
        m.name === "usageTokenChatMessages"
          ? { ...m, usage_token_num: 1200, package_token_amount: 100000 }
          : m,
      ),
    };
    stubFetch(payload);
    const result = await getCodeArtsUsage(PSD);
    expect(result.quotas["Token Package"]).toMatchObject({ used: 1200, total: 100000 });
  });

  it("uses the package end date as the expiry — and treats end_date as exclusive", async () => {
    stubFetch(STATS_RESPONSE);
    const result = await getCodeArtsUsage(PSD);
    const quota = result.quotas["Total Credits"];
    expect(quota.resetAt).not.toBeNull();
    // end_date = 2026-12-03 → 最后有效日 2026-12-02 23:59:59.999 本地时间
    const local = new Date(quota.resetAt);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(11); // December (0-based)
    expect(local.getDate()).toBe(2);
    expect(local.getHours()).toBe(23);
    expect(local.getMinutes()).toBe(59);
    // 积分过期后不会自动补充 → UI 必须说 "Expires" 而不是 "Reset"
    expect(quota.recurring).toBe(false);
  });

  it("leaves the expiry unset when the endpoint omits end_date", async () => {
    stubFetch({ ...STATS_RESPONSE, end_date: undefined });
    const result = await getCodeArtsUsage(PSD);
    expect(result.quotas["Total Credits"].resetAt).toBeNull();
  });

  it("skips zero-total packages instead of showing empty bars", async () => {
    stubFetch(STATS_RESPONSE);
    const result = await getCodeArtsUsage(PSD);
    expect(result.quotas["On-Demand Package"]).toBeUndefined();
  });

  it("reports missing credentials without calling the API", async () => {
    const spy = stubFetch(STATS_RESPONSE);
    const result = await getCodeArtsUsage({});
    expect(spy).not.toHaveBeenCalled();
    expect(result.message).toMatch(/missing AK\/SK/i);
  });

  it("surfaces a rejected AK/SK as an invalid-credential message", async () => {
    stubFetch({ error_msg: "verify ak sk signature fail" }, 401);
    const result = await getCodeArtsUsage(PSD);
    expect(result.message).toMatch(/invalid/i);
  });

  it("surfaces an HTTP error as a quota API error", async () => {
    stubFetch({}, 500);
    const result = await getCodeArtsUsage(PSD);
    expect(result.message).toMatch(/quota API error/i);
  });
});

describe("parseQuotaData for codearts-cn", () => {
  it("forwards used/total and keeps recurring false", () => {
    const parsed = parseQuotaData("codearts-cn", {
      quotas: {
        "Total Credits": { used: 0.26, total: 4600, resetAt: null, recurring: false },
      },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "Total Credits",
      used: 0.26,
      total: 4600,
      resetAt: null,
      recurring: false,
    });
  });

  it("returns an empty list when the provider reports only a message", () => {
    expect(parseQuotaData("codearts-cn", { message: "CodeArts connected. No credit package found." })).toEqual([]);
  });
});
