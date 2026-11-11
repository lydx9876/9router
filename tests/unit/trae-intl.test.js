import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * TRAE International — variants share one executor.
 *
 * Verified: the intl surface runs the same protocol as CN on a different host, so
 * one executor serves both. These tests pin the parts that differ, plus the two
 * failure modes that cost the most time to find:
 *
 *  - 1005 {"plan":N} is a subscription-tier gate, not a transient fault
 *  - intl bills in dollars and reports request-count allowances, not credits
 */

const { TRAE_VARIANTS, traeCnUidFromToken, normalizeTraeCnToken } = await import("../../open-sse/utils/traeVariants.js");
const { default: TraeExecutor } = await import("../../open-sse/executors/trae-cn.js");
const { getTraeCnUsage } = await import("../../open-sse/services/usage/trae-cn.js");
const { explainTraeCnError } = await import("../../open-sse/executors/trae-cn.js");

function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}
const UID = "7706794749382558727";

describe("TRAE variants", () => {
  it("CN and intl use different hosts and client ids", () => {
    expect(TRAE_VARIANTS.cn.chatUrl).toContain("trae-api-cn.mchost.guru");
    expect(TRAE_VARIANTS.intl.chatUrl).toContain("trae-api-us.mchost.guru");
    expect(TRAE_VARIANTS.cn.usageAccounting).toBe("credits");
    expect(TRAE_VARIANTS.intl.usageAccounting).toBe("usd");
  });

  it("intl quota lives on a separate service from CN", () => {
    // CN: POST api.trae.cn/.../pay/ide_user_ent_usage
    // Intl: GET ug-normal.trae.ai/.../pay/user_current_entitlement_list
    expect(TRAE_VARIANTS.cn.usageUrl).toContain("api.trae.cn");
    expect(TRAE_VARIANTS.intl.usageUrl).toContain("ug-normal.trae.ai");
    expect(TRAE_VARIANTS.intl.usageMethod).toBe("GET");
  });
});

describe("TRAE executor variants", () => {
  it("defaults to CN so existing wiring is unchanged", () => {
    const ex = new TraeExecutor();
    expect(ex.variant.label).toBe("trae-cn");
    expect(ex.baseUrl()).toContain("trae-api-cn.mchost.guru");
  });

  it("intl variant points at the intl host", () => {
    const ex = new TraeExecutor("intl");
    expect(ex.variant.label).toBe("trae-intl");
    expect(ex.baseUrl()).toContain("trae-api-us.mchost.guru");
  });

  it("does not derive a channel from a hardcoded default", () => {
    // Channel must come from the catalog; a wrong channel answers 4001.
    const ex = new TraeExecutor("intl");
    const body = ex.buildBody("kimi-k3", { messages: [{ role: "user", content: "hi" }] });
    expect(["solo_work_lite", "solo_agent_remote"]).toContain(body.function);
  });
});

describe("TRAE 1005 tier gate", () => {
  it("reports 1005 as a subscription-tier limit, naming the tier", () => {
    // The upstream says nothing useful here; without this the model just looks
    // broken. The body carries {"plan":4}.
    const msg = explainTraeCnError({ code: 1005, extra: '{"plan":4}' }, "gpt-6.1-sol", "trae-intl");
    expect(msg).toContain("higher subscription tier");
    expect(msg).toContain("plan 4");
    expect(msg).not.toMatch(/rate limit|try again/i);
  });

  it("tolerates a plan payload without a parsable number", () => {
    const msg = explainTraeCnError({ code: 1005, message: "nope" }, "m", "trae-intl");
    expect(msg).toContain("higher subscription tier");
  });
});

describe("TRAE intl usage", () => {
  afterEach(() => vi.unstubAllGlobals());

  const body = {
    is_dollar_usage_billing: true,
    user_entitlement_pack_list: [{
      display_desc: "Free plan",
      entitlement_base_info: {
        end_time: 1796083199,
        quota: {
          basic_usage_limit: 1,
          advanced_model_request_limit: 1000,
          premium_model_fast_request_limit: 10,
          premium_model_slow_request_limit: 50,
          auto_completion_limit: 5000,
          credits_limit: 0,
        },
      },
      usage: { basic_usage_amount: 0.13167 },
    }],
  };

  it("reports the dollar allowance as usd, not credits", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(body), { status: 200 });
    const r = await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { variant: "intl", fetchImpl });
    expect(r.summary).toMatchObject({ total: 1, unit: "usd" });
    expect(r.summary.used).toBeCloseTo(0.13167);
    expect(r.quotas["Free plan (usage)"].unit).toBe("usd");
  });

  it("reports request-count allowances as their own rows", async () => {
    // Rendering `advanced_model_request_limit: 1000` as a credit balance would
    // read as "1000 credits" when it means "1000 advanced-model calls".
    const fetchImpl = async () => new Response(JSON.stringify(body), { status: 200 });
    const r = await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { variant: "intl", fetchImpl });
    expect(r.quotas["Advanced model calls"]).toMatchObject({ total: 1000, unit: "requests" });
    expect(r.quotas["Premium fast calls"]).toMatchObject({ total: 10, unit: "requests" });
  });

  it("skips zero limits instead of rendering an empty row", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(body), { status: 200 });
    const r = await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { variant: "intl", fetchImpl });
    // credits_limit is 0 on intl; it must not appear as a quota row.
    expect(Object.keys(r.quotas).some((k) => /credit/i.test(k))).toBe(false);
  });

  it("uses GET and sends no device identity", async () => {
    // Verified: this endpoint accepts a bare authorization header. Sending the
    // derived device identity is unnecessary, so it must not appear.
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url: String(url), method: init.method, headers: init.headers };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { variant: "intl", fetchImpl });
    expect(captured.method).toBe("GET");
    expect(captured.url).toContain("ug-normal.trae.ai");
    expect(captured.headers["x-device-id"]).toBeUndefined();
    expect(captured.headers.authorization).toMatch(/^Cloud-IDE-JWT /);
  });

  it("surfaces a rejected credential as a readable message", async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ code: 4014, message: "not able to authenticate" }), { status: 200 });
    const r = await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { variant: "intl", fetchImpl });
    expect(r.message).toMatch(/Re-paste|expired/i);
  });
});

describe("TRAE intl static models", () => {
  it("lists only models verified usable on a free account", async () => {
    // The live catalog has ~29 real entries but most answer 1005 plan-gated;
    // listing them would only produce failing picks.
    const { getModelsByProviderId } = await import("../../open-sse/config/providerModels.js");
    const models = getModelsByProviderId("trae-intl");
    expect(models.length).toBe(6);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("kimi-k3");
    expect(ids).toContain("gpt-5.4");
    // paygo models bill the dollar allowance rather than the subscription tier.
    expect(ids.filter((i) => i.endsWith("-paygo")).length).toBe(3);
  });
});
