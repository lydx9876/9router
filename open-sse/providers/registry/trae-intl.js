// TRAE International — the Trae IDE / SOLO surface on www.trae.ai.
//
// ## Why not the existing `trae` entry
//
// `registry/trae.js` implements the legacy SOLO two-step flow
// (POST chat_sessions → GET events) and has three structural limits:
//
//   1. models are a hardcoded list of 9, of which only one was real
//   2. multi-turn messages are flattened into a single text blob
//      (executors/trae.js flattenQuery), so tool_calls and roles are lost
//   3. no tool-call support at all
//
// The intl surface also serves the single-shot `llm_utils_chat` protocol that the
// CN IDE uses. Verified: the CN executor drives it unchanged apart from the host —
// same request body, same SSE frames, same tool_calls accumulation, multi-turn tool
// results included. So this provider reuses that executor rather than the SOLO one.
//
// `trae` is left untouched on purpose: it still works for anyone on that flow, and
// repointing it would break them. This is the better path for new sign-ins.
//
// ## Host is regional
//
// The intl surface answers on trae-api-{us,sg}.mchost.guru and both are
// interchangeable. The *auth* host is NOT fixed: the browser callback returns it
// (e.g. https://api-sg-central.trae.ai) and ExchangeToken must use that value,
// which is why it is stored per-connection instead of hardcoded here.
//
// ## Free accounts have very few usable models
//
// Measured on a free account: 29 real catalog entries, of which only 6 answered.
// The rest reply `1005 {"plan":N}` meaning a higher subscription tier is required,
// and the required tier differs per channel for the same model (kimi-k3 works on
// solo_work_lite but needs plan 5 on solo_agent_remote). The static list below is
// therefore the *verified-usable* set, not the catalog. See services/traeCnModels.js
// for the tier handling.
export default {
  id: "trae-intl",
  alias: "trintl",
  uiAlias: "trintl",
  priority: 31,
  display: {
    name: "Trae International",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TI",
    website: "https://www.trae.ai",
    notice: {
      signupUrl: "https://www.trae.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  credentialForm: "trae-cn",
  authHint:
    "Sign in through the browser for a credential that renews for ~180 days. A pasted " +
    "Cloud-IDE-JWT also works but lasts ~8h with no renewal. The uid is read from the " +
    "token payload. Free accounts can only call a few models — others answer " +
    "\"needs a higher plan\".",
  transport: {
    baseUrl: "https://trae-api-us.mchost.guru/api/agent/v3/llm_utils_chat",
    format: "openai",
    forceStream: true,
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://ug-normal.trae.ai/trae/api/v1/pay/user_current_entitlement_list",
    },
  },
  oauth: {
    // The intl web client id. (CN uses en1oxy7wnw8j9n; they are not interchangeable.)
    clientId: "ono9krqynydwx5",
    clientSecret: "-",
    // api.trae.ai works for the browser-granted refresh token. api.marscode.com
    // panics server-side on this endpoint (nil pointer dereference) — do not use it.
    refreshUrl: "https://api.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken",
    exchangeTokenUrl: "https://api.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken",
  },
  // Verified-usable on a free account (2026-11-11). The live catalog is larger but
  // most entries answer 1005 plan-gated, so listing them would only produce failing
  // picks. `-paygo` models bill against the account's dollar allowance rather than
  // its subscription tier, which is why they are reachable here at all.
  models: [
    { id: "kimi-k3", name: "Kimi-K3" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "gemini-3.1-pro-paygo", name: "Gemini-3.1-Pro-Preview" },
    { id: "gpt-5.2-codex-paygo", name: "GPT-5.2-Codex" },
    { id: "gpt-5-paygo", name: "GPT-5" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};
