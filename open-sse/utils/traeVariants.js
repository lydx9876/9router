// Shared Trae constants — no imports, so anything can depend on this without
// creating a cycle. (The executor imports config/providers.js, which transitively
// reaches back here; keeping the variants in a leaf module breaks that loop.)
export const TRAE_CN_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
export const TRAE_CN_IDE_VERSION = "0.1.52";
export const TRAE_CN_IDE_VERSION_CODE = "20260811";
export const TRAE_CN_DEVICE_TYPE = "macos";
export const TRAE_CN_OS_VERSION = "macOS 15.7.4";
export const TRAE_CN_DEVICE_BRAND = "Apple";
// The user agent is load-bearing, not cosmetic. Controlled comparison against a live
// account with every other header held constant: without it the upstream answers
// {"code":4011,"message":"...exceeded the rate limit"} — the same misleading error
// a wrong device identity produces, which sends people to hunt for a rate limit that
// does not exist. With it, the request streams normally.
export const TRAE_CN_USER_AGENT = "VSCode 1.107.1 (TRAE SOLO CN)";

/**
 * Per-tenant defaults. CN and intl run the *same* protocol on different hosts;
 * everything that differs lives here so one executor serves both.
 *
 * Verified: the CN executor drives the intl surface unchanged apart from
 * `chatUrl` — same request body, same SSE frames, same tool_calls accumulation.
 */
export const TRAE_VARIANTS = {
  cn: {
    label: "trae-cn",
    chatUrl: "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
    catalogUrl: "https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param",
    usageUrl: "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
    usageMethod: "POST",
    usageBody: { require_usage: true, req_source: 2 },
    // CN bills in credits and reports a resolved total.
    usageAccounting: "credits",
    userRegion: "CN",
    packageType: "stable_cn",
  },
  intl: {
    label: "trae-intl",
    // The intl surface is reachable on both regional hosts and they are
    // interchangeable; us is the default because it answered fastest in testing.
    chatUrl: "https://trae-api-us.mchost.guru/api/agent/v3/llm_utils_chat",
    catalogUrl: "https://trae-api-us.mchost.guru/api/ide/v1/batch_get_detail_param",
    // Intl quota lives on a different service and reports per-package request
    // limits plus a dollar allowance — not credits. GET, and it tolerates a
    // bare authorization header.
    usageUrl: "https://ug-normal.trae.ai/trae/api/v1/pay/user_current_entitlement_list",
    usageMethod: "GET",
    usageBody: null,
    usageAccounting: "usd",
    userRegion: "SG",
    packageType: "stable",
    // Verified on a free account (2026-11-11): of ~29 real catalog entries only
    // these answered. Everything else returns 1005 plan-gated. Kept here so the
    // catalog resolver can filter instead of offering picks that always fail.
    usableModelIds: [
      "kimi-k3",
      "gpt-5.4",
      "gpt-5.2",
      "gemini-3.1-pro-paygo",
      "gpt-5.2-codex-paygo",
      "gpt-5-paygo",
    ],
  },
};


// ── Token helpers ────────────────────────────────────────────────────────────
// Pure functions, kept here so the executor and the service layer can both
// use them without importing the executor (which would create a cycle).

/** Pull the uid out of a Cloud-IDE-JWT. Throws with a readable reason when absent. */
export function traeCnUidFromToken(token) {
  const raw = normalizeTraeCnToken(token);
  if (!raw) throw new Error("trae-cn: empty token");
  const parts = raw.split(".");
  if (parts.length < 2) {
    throw new Error("trae-cn: credential is not a Cloud-IDE-JWT (expected 3 dot-separated segments)");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("trae-cn: credential payload is not decodable JSON");
  }
  const uid = payload?.data?.id;
  if (!uid) {
    throw new Error("trae-cn: credential payload has no data.id (uid) — re-copy the token from the IDE");
  }
  return String(uid);
}

/**
 * Strip an optional `Cloud-IDE-JWT ` scheme prefix and all whitespace.
 *
 * The IDE hands users the whole header value, and it is natural to paste it that
 * way, so accept both forms rather than rejecting a correct token. Whitespace is
 * removed rather than merely trimmed because a wrapped line from a terminal or a
 * clipboard inserts a newline mid-token, which otherwise surfaces as an opaque
 * JSON parse error on the payload.
 */
export function normalizeTraeCnToken(token) {
  return String(token || "")
    .replace(/\s+/g, "")
    .replace(/^Cloud-IDE-JWT/i, "");
}

/** Expiry (ms epoch) from a JWT, or null. */
export function traeCnTokenExpiry(token) {
  try {
    const parts = normalizeTraeCnToken(token).split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
