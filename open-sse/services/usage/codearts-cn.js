/**
 * 华为云码道 (CodeArts Doer) usage handler
 *
 * 配额来自 snap-manager 的插件统计接口，用 AK/SK 签名调用即可 —— 不需要 Web
 * 会话 Cookie。这一点和码道的 Web 端积分页（/chat/snap-manager/v1/package/overview，
 * 走 IAM SSO Cookie）不同：后者用 AK/SK 打过去只会拿到 SPA 的 HTML。
 *
 *   GET /snap-manager/v1/statistics/plugin
 *     → { package: {...}, metrics: [...], model_metrics: [...], show: {...} }
 *
 * 顶层 package 字段描述套餐本身：
 *   package_name_cn / package_name_en  套餐名（如「体验版」/ Trial）
 *   status                             normal / closed / freeze
 *   is_credit_package / is_token_package  积分套餐还是 token 套餐
 *   spec_code                          套餐规格码
 *
 * metrics 里是各个额度包，**积分包**字段：
 *   package_credit_amount              总额度
 *   package_credit_used                已用
 *   package_credit_remain              剩余
 *   package_credit_expiring_amount     其中即将过期的部分
 *
 * 官方前端的百分比算法是 used*100/amount（不是 remain/amount），我们保持一致：
 * 9router 的进度条自己按 used/total 画，前端这里只要给出正确的 used/total。
 *
 * token 包字段（usageTokenChatMessages）：
 *   usage_token_num                    已用 token 数
 *   package_token_amount               包内 token 总量（-1 = 不限量）
 *
 * ⚠️ 关于 token 包：官方前端只在 is_token_package 为 true 时展示它，而实测
 * 积分套餐（is_credit_package: true）下 usageTokenChatMessages 的
 * package_token_amount 恒为 1、usage_token_num 是累计消耗 —— 把它当"已用/总量"
 * 展示会得出 537419/1 的荒谬比例。所以 token 包只在 package_token_amount > 1
 * 时才作为配额展示，否则跳过。
 *
 * ⚠️ 接口**不返回**积分的过期时间，所以 resetAt 只能留 null —— UI 会显示
 * "无重置时间"而不是编造一个。这是有意的：宁可少显示，也不要显示错的到期时间。
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { signCodeArtsRequest } from "../../utils/codeartsSignature.js";

const STATS_URL =
  "https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin";

/** metric name → UI 展示名。顺序即展示顺序（总额度在前）。 */
const CREDIT_METRICS = [
  ["usageTotalPackageCredit", "Total Credits"],
  ["usageBasicPackageCredit", "Basic Package"],
  ["usageBonusPackageCredit", "Bonus Package"],
  ["usageOnDemandPackageCredit", "On-Demand Package"],
];

/** 数字字段可能缺失或是 null/undefined，统一收敛为有限数。 */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function getCodeArtsUsage(providerSpecificData = {}, proxyOptions = null) {
  const accessKeyId = String(providerSpecificData?.accessKeyId || "").trim();
  const secretAccessKey = String(providerSpecificData?.secretAccessKey || "").trim();
  const securityToken = String(providerSpecificData?.securityToken || "").trim();

  if (!accessKeyId || !secretAccessKey) {
    return { message: "CodeArts credential not available (missing AK/SK)." };
  }

  let response;
  try {
    const headers = signCodeArtsRequest({
      method: "GET",
      url: STATS_URL,
      accessKeyId,
      secretAccessKey,
      securityToken,
    });
    response = await proxyAwareFetch(STATS_URL, {
      method: "GET",
      headers: { ...headers, Accept: "application/json" },
    }, proxyOptions);
  } catch (error) {
    return { message: `CodeArts quota error: ${error.message}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { message: "CodeArts credential invalid (AK/SK rejected)." };
  }
  if (!response.ok) {
    return { message: `CodeArts quota API error (${response.status}).` };
  }

  let json;
  try {
    json = await response.json();
  } catch {
    return { message: "CodeArts quota API returned a non-JSON response." };
  }

  const metrics = Array.isArray(json?.metrics) ? json.metrics : [];
  if (metrics.length === 0) {
    return { message: "CodeArts connected. No quota data returned." };
  }

  const byName = new Map(metrics.map((m) => [m?.name, m]));
  const quotas = {};

  for (const [metricName, label] of CREDIT_METRICS) {
    const m = byName.get(metricName);
    if (!m || m.show === false) continue;
    const total = num(m.package_credit_amount);
    if (total <= 0) continue;
    quotas[label] = {
      used: num(m.package_credit_used),
      total,
      // The endpoint exposes no expiry timestamp for credit packages. Leaving
      // resetAt null makes the UI say "no reset" rather than invent a date.
      resetAt: null,
      unlimited: false,
      recurring: false,
    };
  }

  // Token 额度包：只在包总量真的是一个 token 数时才展示。积分套餐下这个
  // metric 的 package_token_amount 恒为 1（1 = 无限制的意思），照搬会得到
  // "已用 537419 / 总量 1" 的荒谬读数。
  const tokenPack = byName.get("usageTokenChatMessages");
  if (tokenPack) {
    const total = num(tokenPack.package_token_amount);
    if (total > 1) {
      quotas["Token Package"] = {
        used: num(tokenPack.usage_token_num),
        total,
        resetAt: null,
        unlimited: false,
        recurring: false,
      };
    }
  }

  if (Object.keys(quotas).length === 0) {
    return { message: "CodeArts connected. No credit package found." };
  }

  const pkg = json?.package || {};
  const plan =
    String(pkg.package_name_cn || "").trim() ||
    String(pkg.package_name_en || "").trim() ||
    "CodeArts";

  return { plan, quotas };
}
