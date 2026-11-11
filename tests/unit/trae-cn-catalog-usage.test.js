import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * TRAE CN live catalog, channel routing, and quota reporting.
 *
 * Every assertion encodes something that was verified against a live account,
 * and most of them guard a failure that is silent or misleading:
 *
 *  - trusting `context_window_tokens.max` advertises a window the account cannot
 *    use (max_mode is gated)
 *  - filtering on `is_invisible_to_user` drops about a third of the usable catalog
 *  - internal sub-agent / titling models leaking into the picker
 *  - routing a model to the wrong channel answers `4001 bad request`, which reads
 *    like a formatting problem
 *  - `credits_limit` missing on a package means unlimited, not zero
 *  - `end_time` is unix seconds, exclusive; treating it as ms puts expiry in 1970
 */

const {
  normalizeTraeCnModel,
  traeCnContextWindow,
  isInternalTraeCnModel,
  resolveTraeCnChannel,
  clearTraeCnModelCache,
  resolveTraeCnModels,
  TRAE_CN_CHANNELS,
} = await import("../../open-sse/services/traeCnModels.js");
const { getTraeCnUsage } = await import("../../open-sse/services/usage/trae-cn.js");
const { explainTraeCnError } = await import("../../open-sse/executors/trae-cn.js");

function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}
const UID = "1282504328491419";

const entry = (over = {}) => ({
  config_name: "glm-5.3",
  context_window_tokens: { dev: 200000 },
  display_config: { display_name: "GLM-5.3", multimodal: false, model_capability: "reasoning_model" },
  model_detail_list: [{ max_tokens: 32000 }],
  is_invisible_to_user: false,
  ...over,
});

describe("TRAE CN context window", () => {
  it("takes max, not dev", () => {
    // `max` is the real window and `dev` is the tier the IDE uses when Max is off.
    // Verified: a 400K prompt is accepted on solo_agent_remote, past the dev tier's
    // 168K `prompt_max_tokens`. Preferring `dev` under-reported these by ~5x.
    expect(traeCnContextWindow({ dev: 256000, max: 1000000 })).toBe(1000000);
    expect(traeCnContextWindow({ dev: 200000, max: 1000000 })).toBe(1000000);
  });

  it("falls back to dev when max is absent", () => {
    // The lite channel publishes only `{dev: N}` — that is genuinely its ceiling.
    expect(traeCnContextWindow({ dev: 200000 })).toBe(200000);
    expect(traeCnContextWindow({ dev: 200000, max: 0 })).toBe(200000);
    expect(traeCnContextWindow(null)).toBeNull();
    expect(traeCnContextWindow({})).toBeNull();
  });
});

describe("TRAE CN internal model filtering", () => {
  it("drops sub-agents and machinery models", () => {
    for (const name of [
      "computer_use_subagent", "browser_use_subagent", "search_agent_qwen_fast",
      "title_generation", "input_optimization", "file_search_agent",
      "custom_model_placeholder", "explore_repo", "summary",
    ]) {
      expect(isInternalTraeCnModel(name), `should be internal: ${name}`).toBe(true);
    }
  });

  it("keeps real models", () => {
    for (const name of ["glm-5.3", "glm-5-turbo", "DeepSeek-V4-Pro", "Doubao-Seed-2.1-Pro", "sagitta"]) {
      expect(isInternalTraeCnModel(name), `should be kept: ${name}`).toBe(false);
    }
  });
});

describe("TRAE CN model normalization", () => {
  it("carries the channel so routing never has to guess", () => {
    const m = normalizeTraeCnModel(entry(), "solo_agent_remote");
    expect(m.channel).toBe("solo_agent_remote");
    expect(m.id).toBe("glm-5.3");
    expect(m.name).toBe("GLM-5.3");
    expect(m.contextWindow).toBe(200000);
    expect(m.maxOutputTokens).toBe(32000);
  });

  it("keeps is_invisible_to_user models", () => {
    // The field marks models hidden from the IDE's own picker, not models that
    // cannot be called. Filtering on it drops roughly a third of the catalog.
    const m = normalizeTraeCnModel(entry({ is_invisible_to_user: true }), "solo_work_lite");
    expect(m).not.toBeNull();
    expect(m.invisibleToUser).toBe(true);
  });

  it("reports the widest tier's output limit, not index 0", () => {
    // `model_detail_list` is one entry per tier (`__dev` then `__max`). Index 0 is
    // `__dev` and reports 32K where `__max` allows 64K.
    const m = normalizeTraeCnModel(entry({
      model_detail_list: [{ max_tokens: 32000 }, { max_tokens: 64000 }],
    }), "solo_agent_remote");
    expect(m.maxOutputTokens).toBe(64000);
  });

  it("drops custom models and internal entries", () => {
    expect(normalizeTraeCnModel(entry({ display_config: { is_custom_model: true } }), "x")).toBeNull();
    expect(normalizeTraeCnModel(entry({ config_name: "title_generation" }), "x")).toBeNull();
    expect(normalizeTraeCnModel(entry({ config_name: "" }), "x")).toBeNull();
  });
});

describe("TRAE CN channel routing", () => {
  afterEach(() => clearTraeCnModelCache());

  it("falls back to the first configured channel when nothing is known", () => {
    expect(resolveTraeCnChannel("never-seen-model")).toBe(TRAE_CN_CHANNELS[0]);
  });

  it("picks the channel that offers the wider context when a model appears on both", async () => {
    // A model on both channels is NOT interchangeable: the lite entry exposes only
    // the `__dev` tier while the agent entry carries `__max` with a 1M window.
    // Keeping whichever the catalog listed first cost 22 models ~5x their window.
    const fetchImpl = async () => new Response(JSON.stringify({
      function_configs: [
        {
          function: "solo_work_lite",
          config_info_list: [entry({ context_window_tokens: { dev: 200000 } })],
        },
        {
          function: "solo_agent_remote",
          config_info_list: [entry({ context_window_tokens: { dev: 200000, max: 1000000 } })],
        },
      ],
    }), { status: 200 });

    const res = await resolveTraeCnModels(
      { apiKey: makeJwt({ data: { id: UID } }) },
      { forceRefresh: true, fetchImpl },
    );
    expect(res.models).toHaveLength(1);
    expect(res.models[0].channel).toBe("solo_agent_remote");
    expect(res.models[0].contextWindow).toBe(1000000);
    expect(resolveTraeCnChannel("glm-5.3")).toBe("solo_agent_remote");
  });

  it("breaks a genuine tie by channel priority", async () => {
    // Same window on both channels: still deterministic, not order-dependent.
    const fetchImpl = async () => new Response(JSON.stringify({
      function_configs: [
        { function: "solo_agent_remote", config_info_list: [entry()] },
        { function: "solo_work_lite", config_info_list: [entry()] },
      ],
    }), { status: 200 });

    const res = await resolveTraeCnModels(
      { apiKey: makeJwt({ data: { id: UID } }) },
      { forceRefresh: true, fetchImpl },
    );
    expect(res.models).toHaveLength(1);
    expect(res.models[0].channel).toBe("solo_work_lite");
  });

  it("routes an agent-only model to the agent channel", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      function_configs: [
        { function: "solo_work_lite", config_info_list: [entry()] },
        { function: "solo_agent_remote", config_info_list: [entry({ config_name: "glm-5.1" })] },
      ],
    }), { status: 200 });

    await resolveTraeCnModels(
      { apiKey: makeJwt({ data: { id: UID } }) },
      { forceRefresh: true, fetchImpl },
    );
    expect(resolveTraeCnChannel("glm-5.1")).toBe("solo_agent_remote");
    expect(resolveTraeCnChannel("glm-5.3")).toBe("solo_work_lite");
  });

  it("returns null on a rejected catalog so the caller can fall back", async () => {
    // A catalog failure must never block chatting — the caller falls back to the
    // static list.
    const fetchImpl = async () => new Response(JSON.stringify({ code: 1001, message: "nope" }), { status: 200 });
    expect(await resolveTraeCnModels(
      { apiKey: makeJwt({ data: { id: UID } }) },
      { forceRefresh: true, fetchImpl },
    )).toBeNull();
  });
});

describe("TRAE CN error translation", () => {
  it("explains 4001 as a routing problem, not a format problem", () => {
    // The upstream words this as "bad request", which sends people to inspect the
    // request body — the actual cause is the wrong channel for the model.
    const msg = explainTraeCnError({ code: 4001, message: "bad request" }, "glm-5.1");
    expect(msg).toContain("not available on this channel");
    expect(msg).toContain("glm-5.1");
  });

  it("calls out both 4011 causes", () => {
    const msg = explainTraeCnError({ code: 4011, message: "exceeded the rate limit" }, "m");
    expect(msg).toMatch(/device-identity/);
    expect(msg).toMatch(/user agent/);
  });

  it("suggests re-pasting on 1001", () => {
    expect(explainTraeCnError({ code: 1001, message: "x" }, "m")).toMatch(/re-paste/);
  });
});

describe("TRAE CN usage", () => {
  afterEach(() => vi.unstubAllGlobals());

  const quotaBody = {
    is_credits_billing: true,
    usage_summary: { total_amount: 4600, consumed_amount: 0.51 },
    user_entitlement_pack_list: [
      {
        display_desc: "老用户福利",
        entitlement_base_info: { end_time: 1796979196, quota: { credits_limit: 4000 } },
        usage: {},
      },
      {
        // No credits_limit — this package is unlimited and must not be rendered as 0.
        display_desc: "免费",
        entitlement_base_info: { end_time: 1796054399, quota: { no_bonus_quota: true } },
        usage: {},
      },
      {
        display_desc: "每月登录赠送",
        entitlement_base_info: { end_time: 1796054399, quota: { credits_limit: 500 } },
        usage: { credits_amount: 0.5084 },
      },
    ],
  };

  it("reports each package and marks a limit-less one unlimited", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(quotaBody), { status: 200 });
    const r = await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { fetchImpl });

    expect(r.message).toBeUndefined();
    expect(r.quotas["老用户福利"]).toMatchObject({ total: 4000, unlimited: false });
    expect(r.quotas["免费"].unlimited).toBe(true);
    expect(r.quotas["每月登录赠送"].used).toBeCloseTo(0.5084);
  });

  it("converts end_time from unix seconds to a real date", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(quotaBody), { status: 200 });
    const r = await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { fetchImpl });
    // 1796979196s → 2026-12-11. Treating it as ms would land in January 1970.
    expect(r.quotas["老用户福利"].resetAt).toBe("2026-12-11T08:53:16.000Z");
  });

  it("takes the per-package sum as the total, not the summary", async () => {
    // The summary uses a different accounting basis; the packages are authoritative.
    const fetchImpl = async () => new Response(JSON.stringify({
      ...quotaBody,
      usage_summary: { total_amount: 99999, consumed_amount: 1 },
    }), { status: 200 });
    const r = await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { fetchImpl });
    expect(r.summary.total).toBe(4500);
  });

  it("reports a readable message when the credential is rejected", async () => {
    // A rejected credential arrives as a business code inside a 200.
    const fetchImpl = async () => new Response(
      JSON.stringify({ code: 1001, message: "not able to authenticate" }), { status: 200 });
    const r = await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { fetchImpl });
    expect(r.message).toMatch(/Re-paste|expired/i);
    expect(r.quotas).toBeUndefined();
  });

  it("refuses a credential that is not a JWT", async () => {
    const r = await getTraeCnUsage({ apiKey: "not-a-jwt" });
    expect(r.message).toMatch(/not a valid Cloud-IDE-JWT/);
  });

  it("never issues a write/claim request", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body || "") });
      return new Response(JSON.stringify(quotaBody), { status: 200 });
    };
    await getTraeCnUsage({ apiKey: makeJwt({ data: { id: UID } }) }, null, { fetchImpl });
    for (const c of calls) {
      expect(c.url).not.toMatch(/checkin|claim|redeem/i);
      expect(c.body).not.toMatch(/checkin|claim|redeem/i);
    }
  });
});
