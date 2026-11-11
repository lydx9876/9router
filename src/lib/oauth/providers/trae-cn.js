import { TRAE_CN_CONFIG } from "../constants/traeCn.js";
import { extractJsonPath } from "./_shared.js";
import { deriveTraeCnIdentity } from "open-sse/utils/traeCnIdentity.js";
import { traeCnUidFromToken, normalizeTraeCnToken } from "open-sse/executors/trae-cn.js";

// ───────────────────────────────────────────────────────────────────────────
// Trae CN (国内版) OAuth helpers
//
// Flow (verified end to end against a live account):
//
//   1. Build an authorization URL on www.trae.cn with 17 query params.
//   2. User opens it in a browser and signs in.
//   3. The page redirects to auth_callback_url carrying the tokens *directly* as
//      query params — there is no OAuth ?code= and no PKCE exchange.
//        ?isRedirect=true&scope=solo&refreshToken=<RT>&host=...
//         &refreshExpireAt=<ms>&userRegion=cn&userJwt={...}&userInfo={...}
//   4. ExchangeToken {ClientID, RefreshToken, ClientSecret, UserID} → 14-day token.
//
// The refresh token rotates on every exchange, so the new one must be persisted
// or the next refresh fails.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Device identity for the authorization page.
 *
 * Unlike the intl flow — which invents random ids — CN wants two 15-digit numeric
 * ids, and the portal echoes them back in loginTraceID. Deriving them from the
 * account's own uid keeps a returning user on a stable identity instead of
 * registering a new device on every login.
 */
export function buildTraeCnDeviceContext(uid) {
  const identity = deriveTraeCnIdentity(String(uid || "trae-cn"));
  // machineId is a 64-char hex digest; the portal wants 15 digits. Fold the hex
  // into digits rather than truncating, so a near-identical uid still yields a
  // different machine id.
  let machineId = "";
  for (const ch of identity.machineId) {
    machineId += String(parseInt(ch, 16) % 10);
    if (machineId.length === 15) break;
  }
  return {
    machineId,
    deviceId: identity.deviceId,
  };
}

/**
 * Device identity for an authorization *login*.
 *
 * Deliberately NOT derived from the account uid. A derived deviceId equals the id
 * the account already registered with its IDE, and presenting that same id from a
 * second context is what made the CN authorization page answer "login failed"
 * after the user authenticated — the parameters themselves all validated. The
 * login page is creating a new device registration, so it needs a fresh identity,
 * the same way the IDE's own first sign-in would have.
 *
 * Kept separate from buildTraeCnDeviceContext on purpose: the derived identity is
 * still correct for the chat surface (where a stable device fingerprint is
 * required), so the two uses must not share one helper.
 */
export function buildTraeCnLoginDeviceContext() {
  const digits = (n) => {
    let out = "";
    for (let i = 0; i < n; i++) out += String(Math.floor(Math.random() * 10));
    return out;
  };
  return { machineId: digits(15), deviceId: digits(15) };
}

/**
 * Build the CN authorization URL.
 *
 * Every parameter below is required. Omitting any of auth_from / login_channel /
 * auth_type / redirect / login_trace_id leaves the page stuck on "authorizing"
 * forever — it neither redirects nor reports an error, which is the worst way to
 * fail.
 */
export function buildTraeCnAuthUrl({ loginTraceId, callbackUrl, machineId, deviceId }) {
  const url = new URL(TRAE_CN_CONFIG.authorizationPath, TRAE_CN_CONFIG.consoleUrl);
  const p = new URLSearchParams();
  p.set("login_version", "1");
  p.set("auth_from", TRAE_CN_CONFIG.authFrom);
  p.set("login_channel", "native_ide");
  p.set("plugin_version", TRAE_CN_CONFIG.pluginVersion);
  p.set("auth_type", "local");
  p.set("client_id", TRAE_CN_CONFIG.clientId);
  p.set("redirect", "0");
  p.set("login_trace_id", loginTraceId);
  // The callback parameter is named auth_callback_url. redirect_uri / callback_url
  // are not recognised and produce the same silent hang.
  p.set("auth_callback_url", callbackUrl);
  p.set("machine_id", machineId);
  p.set("device_id", deviceId);
  p.set("x_device_id", deviceId);
  p.set("x_machine_id", machineId);
  p.set("x_device_brand", "PC");
  p.set("x_device_type", "PC");
  p.set("x_os_version", "1.0");
  p.set("x_app_version", TRAE_CN_CONFIG.appVersion);
  p.set("x_app_type", TRAE_CN_CONFIG.appType);
  url.search = p.toString();
  return url.toString();
}

/**
 * Parse the CN callback. Accepts a full URL, a bare query string, or just the
 * refreshToken, because the dashboard lets people paste any of those.
 */
export function parseTraeCnCallback(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("trae-cn: empty callback");

  // A bare refresh token (no separators) is accepted as-is.
  if (!/[?=&{"]/.test(text)) {
    return { refreshToken: text, userInfo: null, userJwt: null, host: null };
  }

  let queryStr = text;
  if (text.includes("?")) queryStr = text.slice(text.indexOf("?") + 1);
  if (queryStr.startsWith("#")) queryStr = queryStr.slice(1);
  const params = Object.fromEntries(new URLSearchParams(queryStr));

  const pick = (...keys) => {
    for (const k of keys) {
      const v = params[k];
      if (v && String(v).trim()) return String(v).trim();
    }
    return null;
  };

  const err = pick("error", "error_code", "errorCode");
  if (err) {
    const desc = pick("error_description", "error_desc", "message");
    throw new Error(desc ? `trae-cn auth failed: ${err} (${desc})` : `trae-cn auth failed: ${err}`);
  }

  const refreshToken = pick("refreshToken", "refresh_token", "RefreshToken", "data");
  if (!refreshToken) throw new Error("trae-cn: callback carries no refreshToken");

  const parseJsonParam = (v) => {
    if (!v) return null;
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  };

  return {
    refreshToken,
    userJwt: parseJsonParam(pick("userJwt", "user_jwt")),
    userInfo: parseJsonParam(pick("userInfo", "user_info")),
    host: pick("host", "loginHost", "consoleHost"),
    refreshExpireAt: Number(pick("refreshExpireAt") || 0) || null,
    userRegion: pick("userRegion"),
    scope: pick("scope"),
  };
}

/**
 * Origins allowed for ExchangeToken.
 *
 * Deliberately a fixed allowlist: `host` arrives in a query string the user could
 * paste from anywhere, so honoring it would let a crafted callback redirect the
 * exchange (and the refresh token in the request body) at an arbitrary host.
 */
function traeCnApiOrigins() {
  return [...TRAE_CN_CONFIG.apiOrigins];
}

/** POST ExchangeToken → {accessToken, refreshToken, expiresAt, refreshExpireAt}. */
export async function exchangeTraeCnToken(refreshToken, { log } = {}) {
  if (!refreshToken) throw new Error("trae-cn: refresh call needs a refreshToken");
  const body = JSON.stringify({
    ClientID: TRAE_CN_CONFIG.clientId,
    RefreshToken: refreshToken,
    ClientSecret: TRAE_CN_CONFIG.clientSecret,
    UserID: "",
  });

  let lastErr = "no successful response";
  for (const origin of traeCnApiOrigins()) {
    const url = `${origin.replace(/\/$/, "")}${TRAE_CN_CONFIG.exchangeTokenPath}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": TRAE_CN_CONFIG.userAgent,
          // Empirically the refresh-token grant expects an EMPTY x-cloudide-token.
          // Sending the old access token routes the request down a different auth
          // branch that demands a device signature.
          "x-cloudide-token": "",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = `${url} HTTP ${res.status}: ${text.slice(0, 200)}`;
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        lastErr = `${url} invalid JSON`;
        continue;
      }
      const bizErr = extractJsonPath(data, [["ResponseMetadata", "Error", "Data", "__Message.error"], ["ResponseMetadata", "Error", "Message"]]);
      // The CN API answers HTTP 200 with a business error envelope, so a 200 alone
      // is not success.
      const token = extractJsonPath(data, [
        ["Result", "Token"], ["Result", "AccessToken"], ["Result", "accessToken"],
        ["result", "token"], ["token"],
      ]);
      if (!token) {
        lastErr = `${url} ${bizErr || "no Token in response"}`;
        continue;
      }
      return {
        accessToken: token,
        refreshToken: extractJsonPath(data, [["Result", "RefreshToken"], ["result", "refresh_token"], ["refreshToken"]]) || refreshToken,
        expiresAt: extractJsonPath(data, [["Result", "TokenExpireAt"], ["Result", "ExpiresAt"], ["expiresAt"]]) || null,
        refreshExpireAt: extractJsonPath(data, [["Result", "RefreshExpireAt"]]) || null,
        clientId: extractJsonPath(data, [["Result", "ClientID"]]) || null,
      };
    } catch (e) {
      lastErr = `${url} ${e.message}`;
    }
  }
  log?.error?.("TOKEN_REFRESH", `trae-cn ExchangeToken failed: ${lastErr}`);
  return { error: "exchange_failed", detail: lastErr };
}

/**
 * Import a pasted credential.
 *
 * Two shapes are accepted, because both are things a user plausibly has:
 *  - a bare Cloud-IDE-JWT (works right away; expires in ~8h with no refresh)
 *  - a full callback URL / query string (yields a 180-day refresh token)
 */
export async function importTraeCnCredential(raw, { log } = {}) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("trae-cn: nothing pasted");

  const looksLikeCallback = /[?=&]/.test(text) && /refreshToken|refresh_token|data=/.test(text);
  if (!looksLikeCallback) {
    const token = normalizeTraeCnToken(text);
    const uid = traeCnUidFromToken(token);
    return {
      accessToken: token,
      refreshToken: null,
      uid,
      authMethod: "imported",
      expiresIn: 8 * 60 * 60, // IDE session tokens last ~8h and cannot be renewed
    };
  }

  const parsed = parseTraeCnCallback(text);
  const exchanged = await exchangeTraeCnToken(parsed.refreshToken, { log });
  if (exchanged.error) throw new Error(`trae-cn: ${exchanged.detail || "exchange failed"}`);

  const uid = parsed.userInfo?.UserID
    || parsed.userJwt?.UserID
    || safeUid(exchanged.accessToken);

  return {
    accessToken: exchanged.accessToken,
    // Persist the ROTATED token: the one from the callback is already spent.
    refreshToken: exchanged.refreshToken,
    refreshExpireAt: exchanged.refreshExpireAt || parsed.refreshExpireAt,
    uid: uid ? String(uid) : null,
    email: parsed.userInfo?.Email || parsed.userInfo?.NonPlainTextEmail || null,
    displayName: parsed.userInfo?.ScreenName || null,
    region: parsed.userInfo?.AIRegion || parsed.userRegion || "CN",
    authMethod: "oauth",
    expiresIn: exchanged.expiresAt
      ? Math.max(60, Math.floor((Number(exchanged.expiresAt) - Date.now()) / 1000))
      : 14 * 24 * 60 * 60,
  };
}

function safeUid(token) {
  try {
    return traeCnUidFromToken(token);
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Provider descriptor consumed by generateAuthData / exchangeTokens.
//
// Mirrors the intl `trae` descriptor. Differences that matter:
//  - no GetLoginGuidance call: CN always serves the console at www.trae.cn
//  - device ids are derived from the account uid rather than random, so a
//    returning user keeps one device identity instead of registering a new one
//  - the callback carries tokens directly, so there is no code exchange
// ───────────────────────────────────────────────────────────────────────────

/** 16-digit trace id used when the caller does not supply a session state. */
export function generateLoginTraceId() {
  return String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
}

const traeCn = {
  config: TRAE_CN_CONFIG,
  flowType: "authorization_code",
  callbackPath: TRAE_CN_CONFIG.callbackPath,

  prepareConfig: async (config, meta = {}) => {
    // login_trace_id has two jobs: it is an authorization-page parameter, and it is
    // what the proxy uses to match an incoming callback to this login session. The
    // caller passes the session state in, so both sides share one value — minting a
    // fresh id here would make the callback unmatchable.
    const loginTraceId = meta.state || meta.loginTraceId || generateLoginTraceId();
    // A login registers a NEW device, so it uses a fresh identity rather than the
    // account's existing derived one — see buildTraeCnLoginDeviceContext.
    const { machineId, deviceId } = buildTraeCnLoginDeviceContext();
    // Both spellings on purpose: generateAuthData() reads `config.loginTraceID` to
    // use as the flow state, while this module's own code reads `config.loginTraceId`.
    return { ...config, loginTraceId, loginTraceID: loginTraceId, machineId, deviceId };
  },

  buildAuthUrl: (config, redirectUri) => {
    return buildTraeCnAuthUrl({
      loginTraceId: config.loginTraceId,
      callbackUrl: redirectUri,
      machineId: config.machineId,
      deviceId: config.deviceId,
    });
  },

  // The "code" here is whatever the user pasted or the proxy received: either a
  // full callback query (tokens included) or a bare Cloud-IDE-JWT.
  exchangeToken: async (_config, code) => {
    const cred = await importTraeCnCredential(code);
    return {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresIn: cred.expiresIn,
      _authMethod: cred.authMethod,
      _uid: cred.uid,
      _region: cred.region,
      _refreshExpireAt: cred.refreshExpireAt,
      _displayName: cred.displayName,
      _email: cred.email,
    };
  },

  postExchange: async (tokens) => ({ userInfo: { uid: tokens._uid } }),

  mapTokens: (tokens) => ({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    email: tokens._email || undefined,
    displayName: tokens._displayName || undefined,
    providerSpecificData: {
      authMethod: tokens._authMethod || "oauth",
      uid: tokens._uid || null,
      refreshToken: tokens.refreshToken || null,
      refreshExpireAt: tokens._refreshExpireAt || null,
      region: tokens._region || "CN",
    },
  }),
};

export default traeCn;
