// TRAE CN — the Trae IDE that ships with www.trae.cn (ByteDance).
//
// ## Why a separate provider from `trae`
//
// TRAE runs two mutually incompatible API surfaces and their tokens do not cross:
//
//   intl "SOLO" (registry/trae.js)    core-normal.trae.ai/api/remote/v1/chat_sessions
//   CN IDE    (this file)             trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
//
// A Cloud-IDE-JWT minted by the CN IDE applied to the SOLO host answers
// `{"code":1001,"message":"...not able to authenticate you."}` — verified on four
// hosts (cn/sg/us SOLO edges). So this cannot be a flag on the existing entry:
// pointing `trae` at the CN host would break every intl user, and vice versa.
//
// ## Auth
//
// The IDE issues a Cloud-IDE-JWT (~8h) plus a refreshToken. There is no OAuth
// handshake 9Router can drive — the callback is the IDE's own loopback on a fixed
// port and returns IDE-private fields — so credentials are pasted:
//
//   apiKey        the full JWT (already prefixed with "Cloud-IDE-JWT ")
//   refreshToken  obtained alongside it; renews access + rotates itself
//
// The uid needed for signing is read from the JWT payload (`data.id`). Do NOT call
// GetUserInfo for it: that endpoint answers `20310 The user is not logged in` for
// these tokens even with a complete IDE header set.
export default {
  id: "trae-cn",
  alias: "trcn",
  uiAlias: "trcn",
  priority: 30,
  display: {
    name: "Trae CN",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TR",
    website: "https://www.trae.cn",
    notice: {
      signupUrl: "https://www.trae.cn",
    },
  },
  category: "apikey",
  authModes: ["apikey"],
  // Dedicated two-field credential form (JWT + refreshToken) instead of the generic
  // single API-key input — see providers/new/page.js::usesTraeCnCredentialForm.
  credentialForm: "trae-cn",
  // The JWT is the credential; there is nothing to run an OAuth flow against.
  authHint:
    "Paste the Cloud-IDE-JWT from the Trae CN IDE, and the refreshToken that comes with it. " +
    "The uid is read from the token payload — no extra fields needed.",
  transport: {
    // Single-shot SSE endpoint (the intl SOLO entry uses a two-step session flow).
    baseUrl: "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
    format: "openai",
    // Upstream always streams. ChatCore turns the SSE into a chat.completion when
    // the client asked for JSON, so the executor only ever produces streams.
    forceStream: true,
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
    },
  },
  // Refresh: POST ExchangeToken {ClientID, RefreshToken, ClientSecret, UserID}.
  // Returns a new access token AND a new refreshToken (rotation — the old one dies
  // immediately). Wired in services/tokenRefresh/providers.js.
  oauth: {
    // CN uses the SOLO/IDE client id. The web-side id (ono9krqynydwx5) is what the
    // intl surface uses and is rejected here with "refresh token is not matched to
    // the client" — the refresh token is bound to the client that minted it.
    clientId: "en1oxy7wnw8j9n",
    clientSecret: "-",
    // ExchangeToken lives on the new CN domain. api.trae.cn answers the same body
    // but rejects the credential, so the origin is not interchangeable.
    refreshUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    exchangeTokenUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
  },
  // Static fallback only. The real catalog is per-account and comes from
  // /api/ide/v1/batch_get_detail_param — this is what to show when that fetch
  // fails. Kept to keys observed in live CN catalogs (2026-11-10) so a failed
  // catalog fetch still leaves a list the upstream will actually serve.
  //
  // Note the casing: TRAE publishes mixed-case keys (`DeepSeek-V4-Pro`,
  // `Doubao-Seed-2.1-Pro`) alongside lowercase ones, and it is case-sensitive.
  models: [
    { id: "auto", name: "Auto" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5", name: "GLM-5" },
    { id: "glm-5-turbo", name: "GLM-5-Turbo" },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro" },
    { id: "kimi-k3", name: "Kimi-K3" },
    { id: "kimi-k2.7-code", name: "Kimi-K2.7-Code" },
    { id: "DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro" },
    { id: "DeepSeek-V4-Flash", name: "DeepSeek-V4-Flash" },
    { id: "qwen3.8-max", name: "Qwen3.8-Max" },
    { id: "qwen-3.7-plus", name: "Qwen3.7-Plus" },
    { id: "Doubao-Seed-2.1-Pro", name: "Doubao-Seed-2.1-Pro" },
    { id: "Doubao-Seed-2.1-Turbo", name: "Doubao-Seed-2.1-Turbo" },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash" },
    { id: "minimax-m3", name: "MiniMax-M3" },
    { id: "step-5-preview", name: "Step-5-Preview" },
    // Frontier reasoning pair — routed through a static model_config upstream,
    // so they stay available even though the catalog often omits them.
    { id: "smodel", name: "Sonus" },
    { id: "cmodel", name: "Cantus" },
  ],
  features: {
    usage: true,
    // quirk: the quota endpoint is POST with a fixed JSON body, not GET. The usage
    // handler builds the request itself, so this only records that the provider has
    // a quota source at all.
    usageApikey: true,
  },
};
