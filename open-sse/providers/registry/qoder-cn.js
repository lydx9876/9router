export default {
  id: "qoder-cn",
  priority: 30,
  alias: "qdcn",
  uiAlias: "qdcn",
  display: {
    name: "Qoder CN",
    icon: "water_drop",
    color: "#EC4899",
    website: "https://qoder.com.cn",
    notice: {
      signupUrl: "https://qoder.com.cn",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "Personal Access Token (pt-...) from https://qoder.com.cn/account/integrations",
  transport: {
    baseUrl: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://openapi.qoder.com.cn/api/v2/quota/usage",
    },
  },
  // Mirrors what `GET /algo/api/v2/model/list` returns for a live CN account
  // (verified 2026-11-10 against two accounts). The list is per-account, so keep
  // it to keys the CN gateway actually publishes: the old tier aliases
  // (`performance`, `lite`, `qmodel_latest`, `qmodel`) are not in any CN catalog
  // and produced `model_config for "X" not yet known` on every probe. `jmodel`
  // (Step-5-Preview) is CN-only and was missing entirely.
  models: [
    { id: "auto", name: "Auto" },
    { id: "qmodel_38max", name: "Qwen3.8-Max" },
    { id: "qfmodel", name: "Qwen3.8-Flash" },
    { id: "kmodel_latest", name: "Kimi-K3.1-Pro" },
    { id: "kmodel", name: "Kimi-K2.8-Preview" },
    { id: "jmodel", name: "Step-5-Preview" },
    { id: "gmodel", name: "GLM-5.3" },
    { id: "gfmodel", name: "GLM-5.3-Flash" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    { id: "dfmodel", name: "DeepSeek-Flash" },
    { id: "mmodel", name: "MiniMax-M3.1-Flash" },
    // Frontier reasoning pair. Absent from many per-account catalogs, so the
    // executor falls back to a static model_config (see constants.js).
    { id: "smodel", name: "Sonus" },
    { id: "cmodel", name: "Cantus" },
  ],
  oauth: {
    openApiBaseUrl: "https://openapi.qoder.com.cn",
    centerBaseUrl: "https://gateway.qoder.com.cn",
    chatBaseUrl: "https://gateway.qoder.com.cn",
    deviceTokenUrl: "https://openapi.qoder.com.cn/api/v1/deviceToken/poll",
    refreshUrl: "https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token",
    userInfoUrl: "https://openapi.qoder.com.cn/api/v1/userinfo",
    quotaUsageUrl: "https://openapi.qoder.com.cn/api/v2/quota/usage",
    loginUrl: "https://qoder.com.cn/device/selectAccounts",
  },
  features: {
    usage: true,
    // PAT (apikey) connections also carry quota usage (via job-token exchange).
    usageApikey: true,
  },
};
