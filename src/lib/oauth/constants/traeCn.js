// Trae CN (国内版) OAuth constants — separate from the intl TRAE_CONFIG.
//
// CN is a different system from intl: different console, different API host, and
// different client_id. Mixing the two answers 1001 "not able to authenticate"
// everywhere. Everything below was verified against a live CN account.
export const TRAE_CN_CONFIG = {
  // ⚠️ CN uses the SOLO/IDE client id. The web-side id (ono9krqynydwx5) that the
  // intl flow uses is rejected by the CN portal with a 404.
  clientId: "en1oxy7wnw8j9n",
  clientSecret: "-",
  // Console that serves the authorization page.
  consoleUrl: "https://www.trae.cn",
  authorizationPath: "/authorization",
  // ExchangeToken lives on the new CN domain. api.trae.cn still answers but rejects
  // the same body, so the origin is not interchangeable.
  apiOrigins: ["https://api.trae.com.cn", "https://api.trae.cn"],
  exchangeTokenPath: "/cloudide/api/v3/trae/oauth/ExchangeToken",
  // Chat + model catalog host (different host again from the auth API).
  agentOrigin: "https://trae-api-cn.mchost.guru",
  callbackPath: "/callback",
  // Values the CN authorization page requires verbatim. Verified: the page opens
  // and completes with exactly these.
  pluginVersion: "2.3.62834",
  appVersion: "0.1.52",
  appType: "stable",
  authFrom: "solo",
  scope: "solo",
  userAgent: "VSCode 1.107.1 (TRAE SOLO CN)",
  authScheme: "Cloud-IDE-JWT",
  // ExchangeToken returns a ~14 day access token and a ~180 day refresh token.
  tokenLifetimeDays: 14,
  refreshLifetimeDays: 180,
  oauthTimeoutMs: 600_000,
};
