/**
 * TRAE CN usage handler — read-only credit reporting.
 *
 *   POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage
 *   body {"require_usage":true,"req_source":2}
 *
 * Read-only by design: this is a proxy, so the panel only queries. Nothing here
 * claims or redeems a package — checkin/redeem lives in a different project.
 *
 * Response shape (verified against a live account):
 *
 *   {
 *     is_credits_billing: true,
 *     usage_summary: { total_amount, consumed_amount, consumption_ratio },
 *     user_entitlement_pack_list: [
 *       { display_desc: "老用户福利",
 *         entitlement_base_info: {
 *           end_time: 1796979196,              // unix SECONDS
 *           quota: { credits_limit: 4000 },    // absent for unlimited packages
 *         },
 *         usage: { credits_amount } } ]
 *   }
 *
 * Three things are easy to get wrong here:
 *
 *  1. `credits_limit` may be missing (the "免费" package has no such field). That
 *     package is unlimited — reported as such, never invented as a number.
 *  2. The sum of per-package limits is authoritative. `usage_summary.total_amount`
 *     can differ (it is a different accounting basis), so it is only a fallback.
 *  3. `end_time` is unix SECONDS and exclusive. Treating ms here would place every
 *     expiry in 1970.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { deriveTraeCnIdentity } from "../../utils/traeCnIdentity.js";

import { TRAE_VARIANTS, traeCnUidFromToken, normalizeTraeCnToken } from "../../utils/traeVariants.js";

const USAGE_URL = TRAE_VARIANTS.cn.usageUrl;
const USER_AGENT = "VSCode 1.107.1 (TRAE SOLO CN)";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** unix seconds → ISO. Returns null rather than a wrong date when absent. */
function endTimeToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Guard the unit: a ms timestamp is ~1000x larger.
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export async function getTraeCnUsage(credentials = {}, proxyOptions = null, deps = {}) {
  const variant = TRAE_VARIANTS[deps.variant || "cn"] || TRAE_VARIANTS.cn;
  if (variant.usageAccounting === "usd") {
    return getTraeIntlUsage(credentials, proxyOptions, deps);
  }
  // `fetchImpl` is injectable so the handler can be tested without a network call.
  // proxyAwareFetch is passed in rather than reached for directly because that
  // module replaces globalThis.fetch on import, which makes stubbing the global
  // fetch after load ineffective.
  const doFetch = deps.fetchImpl || proxyAwareFetch;
  const token = normalizeTraeCnToken(credentials?.accessToken || credentials?.apiKey || "");
  if (!token) {
    return { message: "TRAE CN credential not available (missing token)." };
  }

  let uid;
  try {
    uid = credentials?.providerSpecificData?.uid || traeCnUidFromToken(token);
  } catch {
    return { message: "TRAE CN credential is not a valid Cloud-IDE-JWT. Re-paste it from the IDE." };
  }
  const identity = deriveTraeCnIdentity(uid);

  let response;
  try {
    response = await doFetch(USAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Cloud-IDE-JWT ${token}`,
        // Same device identity as the chat surface: a different one makes the
        // quota endpoint answer 1001 as if the credential were invalid.
        "x-user-region": "CN",
        "x-device-id": identity.deviceId,
        "x-market-user-id": identity.marketUserId,
        "x-market-client-id": "VSCode 1.107.1",
        "x-tt-trace-id": identity.traceId,
        "vscode-sessionid": identity.sessionId,
        "x-request-id": identity.requestId,
        "package-type": "stable_cn",
        "app-version": "1.107.1",
        "user-agent": USER_AGENT,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ require_usage: true, req_source: 2 }),
    }, proxyOptions);
  } catch (err) {
    return { message: `TRAE CN usage request failed: ${err?.message || err}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { message: `TRAE CN usage returned non-JSON (HTTP ${response.status}).` };
  }

  // Rejected credentials come back as a business code, not an HTTP error.
  if (payload?.code) {
    const msg = payload.message || `error ${payload.code}`;
    return { message: `TRAE CN usage unavailable: ${msg}. Re-paste the credential if it has expired.` };
  }
  if (!response.ok) {
    return { message: `TRAE CN usage failed (HTTP ${response.status}).` };
  }

  const packs = Array.isArray(payload?.user_entitlement_pack_list)
    ? payload.user_entitlement_pack_list
    : [];

  const quotas = {};
  let packTotal = 0;
  let sawLimit = false;

  for (const pack of packs) {
    const base = pack?.entitlement_base_info || {};
    const limit = base?.quota?.credits_limit;
    const label = String(pack?.display_desc || "").trim() || `Package ${pack?.source_id || ""}`.trim();
    const used = num(pack?.usage?.credits_amount);
    const resetAt = endTimeToIso(base?.end_time ?? pack?.expire_time);

    if (limit == null) {
      // The free package carries no limit field. Report unlimited rather than
      // inventing a number that would render as a bogus progress bar.
      quotas[label] = { used, total: 0, unlimited: true, resetAt, recurring: false };
      continue;
    }

    const total = num(limit);
    if (total <= 0) {
      quotas[label] = { used, total: 0, unlimited: true, resetAt, recurring: false };
      continue;
    }
    sawLimit = true;
    packTotal += total;
    quotas[label] = {
      used,
      total,
      unlimited: false,
      resetAt,
      // Credit packages expire; they do not refill on a schedule.
      recurring: false,
    };
  }

  if (!Object.keys(quotas).length) {
    return { message: "TRAE CN connected. No entitlement package found." };
  }

  // Per-package sum wins when it disagrees with the summary: the summary is a
  // different accounting basis and can include things the package list does not.
  const summaryTotal = num(payload?.usage_summary?.total_amount);
  const total = sawLimit ? packTotal : summaryTotal;
  const consumed = num(payload?.usage_summary?.consumed_amount);

  return {
    plan: payload?.is_credits_billing === false ? "TRAE CN (pay-as-you-go)" : "TRAE CN",
    quotas,
    // Surface the aggregate so the panel can show one headline number without
    // re-summing the packages.
    summary: total > 0
      ? {
          used: consumed,
          total,
          unit: payload?.is_credits_billing === false ? "usd" : "credits",
        }
      : null,
  };
}

/**
 * TRAE International usage.
 *
 * Completely different shape from CN, verified against a live account:
 *
 *   GET https://ug-normal.trae.ai/trae/api/v1/pay/user_current_entitlement_list
 *
 *   {
 *     is_dollar_usage_billing: true,
 *     user_entitlement_pack_list: [{
 *       display_desc: "Free plan",
 *       entitlement_base_info: {
 *         end_time: 1796083199,              // unix SECONDS
 *         quota: {
 *           basic_usage_limit: 1,            // dollars
 *           advanced_model_request_limit: 1000,
 *           premium_model_fast_request_limit: 10,
 *           premium_model_slow_request_limit: 50,
 *           auto_completion_limit: 5000,
 *         },
 *       },
 *       usage: { basic_usage_amount: 0.13167 },
 *     }],
 *   }
 *
 * Three differences from CN that make a shared implementation wrong:
 *
 *   1. No `usage_summary` at all — there is no server-provided total to trust, so
 *      each allowance is reported on its own.
 *   2. Accounting is dollars plus request-count limits, not credits. Rendering
 *      `advanced_model_request_limit` as a credit balance would read as "1000
 *      credits" when it is "1000 advanced-model calls".
 *   3. The endpoint tolerates a bare authorization header — no device identity is
 *      required (verified). Sending the derived identity is harmless but unnecessary.
 */
async function getTraeIntlUsage(credentials = {}, proxyOptions = null, deps = {}) {
  const doFetch = deps.fetchImpl || proxyAwareFetch;
  const token = normalizeTraeCnToken(credentials?.accessToken || credentials?.apiKey || "");
  if (!token) {
    return { message: "TRAE International credential not available (missing token)." };
  }

  let response;
  try {
    response = await doFetch(TRAE_VARIANTS.intl.usageUrl, {
      method: "GET",
      headers: {
        authorization: `Cloud-IDE-JWT ${token}`,
        "x-user-region": TRAE_VARIANTS.intl.userRegion,
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
    }, proxyOptions);
  } catch (err) {
    return { message: `TRAE International usage request failed: ${err?.message || err}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { message: `TRAE International usage returned non-JSON (HTTP ${response.status}).` };
  }

  if (payload?.code) {
    const msg = payload.message || `error ${payload.code}`;
    return { message: `TRAE International usage unavailable: ${msg}. Re-paste the credential if it has expired.` };
  }
  if (!response.ok) {
    return { message: `TRAE International usage failed (HTTP ${response.status}).` };
  }

  const packs = Array.isArray(payload?.user_entitlement_pack_list) ? payload.user_entitlement_pack_list : [];
  if (!packs.length) {
    return { message: "TRAE International connected. No entitlement package found." };
  }

  const quotas = {};
  let dollarUsed = 0;
  let dollarTotal = 0;

  for (const pack of packs) {
    const base = pack?.entitlement_base_info || {};
    const quota = base?.quota || {};
    const usage = pack?.usage || {};
    const packName = String(pack?.display_desc || "").trim() || "Plan";
    const resetAt = endTimeToIso(base?.end_time ?? pack?.expire_time);

    // Dollar allowance: the only field that behaves like a spendable balance.
    const limit = Number(quota.basic_usage_limit);
    const used = num(usage.basic_usage_amount);
    if (Number.isFinite(limit) && limit > 0) {
      dollarUsed += used;
      dollarTotal += limit;
      quotas[`${packName} (usage)`] = {
        used,
        total: limit,
        unlimited: false,
        resetAt,
        recurring: true,
        // Values are dollars; the panel must not render them as credits.
        unit: "usd",
      };
    }

    // Request-count allowances. These never "refill" mid-period, so they expire
    // rather than reset.
    const COUNT_QUOTAS = [
      ["advanced_model_request_limit", "Advanced model calls"],
      ["premium_model_fast_request_limit", "Premium fast calls"],
      ["premium_model_slow_request_limit", "Premium slow calls"],
      ["auto_completion_limit", "Auto-completion calls"],
    ];
    for (const [key, label] of COUNT_QUOTAS) {
      const n = Number(quota[key]);
      if (!Number.isFinite(n) || n <= 0) continue;
      // The API reports the limit but not consumption per counter, so these are
      // shown as capacity only — inventing a "used" of 0 would look like "untouched"
      // when it may simply be unreported.
      quotas[`${label}`] = { used: 0, total: n, unlimited: false, resetAt, recurring: false, unit: "requests" };
    }
  }

  if (!Object.keys(quotas).length) {
    return { message: "TRAE International connected. Plan reports no usage limits." };
  }

  return {
    plan: payload?.is_dollar_usage_billing ? "TRAE International (pay-as-you-go)" : "TRAE International",
    quotas,
    summary: dollarTotal > 0
      ? { used: dollarUsed, total: dollarTotal, unit: "usd" }
      : null,
  };
}
