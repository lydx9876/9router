/**
 * TRAE CN live model catalog.
 *
 * Fetches the account's real model list and, with it, the channel (`function`)
 * each model is served on. Both matter:
 *
 *  - The static registry list is a guess. On the live catalog the real names
 *    differ, and picking one that does not exist answers
 *    `model_config not yet known`.
 *  - A model is only callable on the channel that lists it. Using the wrong one
 *    answers `4001 bad request` — which reads like a body-format problem and
 *    sends you looking in the wrong place. So the channel is carried alongside
 *    each model rather than assumed.
 *
 * Endpoint:
 *
 *   POST /api/ide/v1/batch_get_detail_param
 *   {"functions":["solo_work_lite","solo_agent_remote"],"need_prompt":false,"poly_prompt":true}
 *
 * The batch form is required: the single-function `get_detail_param` only ever
 * shows one channel's models, so agent-only models stay invisible.
 */

import { createHash } from "crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { deriveTraeCnIdentity } from "../utils/traeCnIdentity.js";
import { TRAE_VARIANTS, traeCnUidFromToken, normalizeTraeCnToken } from "../utils/traeVariants.js";

export const TRAE_CN_CATALOG_URL = TRAE_VARIANTS.cn.catalogUrl;
/** Catalog URL per variant — CN and intl serve it on different hosts. */
export function traeCatalogUrl(variant = "cn") {
  return (TRAE_VARIANTS[variant] || TRAE_VARIANTS.cn).catalogUrl;
}
const USER_AGENT = "VSCode 1.107.1 (TRAE SOLO CN)";
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Channels to query, in routing priority order.
 *
 * When a model appears on both, the first channel wins — deterministically, so
 * the same model always routes the same way. `solo_work_lite` is the lighter
 * surface and is tried first; it is also where the general-purpose chat models
 * live, so preferring it keeps the common case on the cheaper path.
 */
export const TRAE_CN_CHANNELS = ["solo_work_lite", "solo_agent_remote"];

/**
 * Internal entries that are not user-selectable models: sub-agents and the
 * machinery models used for titling / summarizing / searching.
 */
const INTERNAL_MODEL_PATTERN =
  /(^|_)(subagent|sub_agent|search_agent|title_generation|input_optimization|file_search_agent|laziness_detection|intent_detection|rerank)$|^(summary|laziness_|explore_|custom_model_)/i;

/** @type {Map<string, { expiresAt: number, models: object[], channels: Map<string,string> }>} */
const catalogCache = new Map();

/** @type {Map<string, string>} model id → channel, for the last resolved catalog */
const channelByModel = new Map();

export function isInternalTraeCnModel(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  if (INTERNAL_MODEL_PATTERN.test(n)) return true;
  // Explicit forms that the pattern above cannot express cleanly.
  return n.endsWith("_subagent") || n.endsWith("_agent") || n.startsWith("search_agent");
}

/**
 * `context_window_tokens` is an object: `{dev: 200000}` or
 * `{dev: 256000, max: 1000000}`.
 *
 * `max` is the real window. An earlier version preferred `dev`, assuming `max`
 * needed an account flag to be usable — that was wrong. Verified against the CN
 * endpoint: a 400K-token prompt is accepted on `solo_agent_remote`, well past the
 * `dev` tier's 168K `prompt_max_tokens`. `dev` is the tier the IDE uses when Max
 * is off, not a hard ceiling, so preferring it under-reported every model that has
 * a `__max` tier by roughly 5x.
 */
export function traeCnContextWindow(raw) {
  if (typeof raw === "number") return raw > 0 ? raw : null;
  if (!raw || typeof raw !== "object") return null;
  const max = Number(raw.max);
  if (Number.isFinite(max) && max > 0) return max;
  const dev = Number(raw.dev);
  return Number.isFinite(dev) && dev > 0 ? dev : null;
}

/** Normalize one catalog entry, or null when it is not a user-selectable model. */
export function normalizeTraeCnModel(entry, channel) {
  const id = String(entry?.config_name || "").trim();
  if (!id) return null;

  const display = entry?.display_config || {};
  // Custom models are the account's own uploads, not catalog entries.
  if (display.is_custom_model === true) return null;
  if (isInternalTraeCnModel(id)) return null;

  // NOTE: `is_invisible_to_user` is deliberately NOT a filter. It marks models
  // hidden from the IDE's own picker, not models that cannot be called — several
  // work fine. Filtering on it drops roughly a third of the usable catalog.
  // `model_detail_list` holds one entry per tier (`__dev`, `__max`). The widest
  // tier is the one whose limits actually apply, so take the max across entries
  // instead of trusting index 0 — index 0 is `__dev`, which reports 32K output
  // where the `__max` tier allows 64K.
  const details = Array.isArray(entry?.model_detail_list) ? entry.model_detail_list : [];
  const maxOutput = details.reduce((acc, d) => {
    const n = Number(d?.max_tokens);
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);

  return {
    id,
    name: String(display.display_name || id).trim(),
    // Carried on every model so the executor never has to guess the channel —
    // guessing is what produces 4001 for models that only exist on one channel.
    channel,
    contextWindow: traeCnContextWindow(entry?.context_window_tokens),
    maxOutputTokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : null,
    vision: display.multimodal === true,
    reasoning: display.model_capability === "reasoning_model" || undefined,
    // Kept for diagnostics; not used for availability.
    invisibleToUser: entry?.is_invisible_to_user === true,
  };
}

function readToken(credentials) {
  return normalizeTraeCnToken(credentials?.accessToken || credentials?.apiKey || "");
}

function cacheKey(token, variant = "cn") {
  return createHash("sha256").update(`${variant}:${token.slice(-32)}`).digest("hex");
}

async function fetchCatalog(token, { proxyOptions = null, log, fetchImpl, variant = "cn" } = {}) {
  // Injectable for tests: proxyFetch.js replaces globalThis.fetch on import, so
  // stubbing the global fetch after load does not intercept it.
  const doFetch = fetchImpl || proxyAwareFetch;
  let uid;
  try {
    uid = traeCnUidFromToken(token);
  } catch (err) {
    log?.warn?.("TRAE_CN_MODELS", `cannot derive uid: ${err.message}`);
    return null;
  }
  const identity = deriveTraeCnIdentity(uid);

  const res = await doFetch(traeCatalogUrl(variant), {
    method: "POST",
    headers: {
      authorization: `Cloud-IDE-JWT ${token}`,
      "x-cloudide-token": token,
      "x-ide-token": token,
      "x-uid": uid,
      "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
      "x-ide-version": "0.1.52",
      "x-ide-version-code": "20260811",
      "x-app-version-code": "20260811",
      "x-ide-version-type": "stable",
      "x-device-type": "macos",
      "x-os-version": "macOS 15.7.4",
      "x-device-brand": "Apple",
      "x-machine-id": identity.machineId,
      "x-device-id": identity.deviceId,
      "request-traffic-type": "prod",
      "user-agent": USER_AGENT,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      functions: TRAE_CN_CHANNELS,
      need_prompt: false,
      poly_prompt: true,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }, proxyOptions);

  if (!res.ok) {
    log?.warn?.("TRAE_CN_MODELS", `catalog HTTP ${res.status}`);
    return null;
  }
  const payload = await res.json();
  if (payload?.code) {
    log?.warn?.("TRAE_CN_MODELS", `catalog error ${payload.code}: ${payload.message || ""}`);
    return null;
  }
  return payload;
}

/**
 * Resolve the live catalog for a connection.
 *
 * Returns `{ models, channels }` or null. Null means "no live catalog" and the
 * caller is expected to fall back to the static list — a catalog fetch failure
 * must never block chatting.
 */
export async function resolveTraeCnModels(credentials, options = {}) {
  const token = readToken(credentials);
  if (!token) return null;

  const key = cacheKey(token, options.variant || "cn");
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) return cached;
  }

  let payload;
  try {
    payload = await fetchCatalog(token, options);
  } catch (err) {
    options.log?.warn?.("TRAE_CN_MODELS", err.message);
    return null;
  }
  if (!payload) return null;

  const groups = Array.isArray(payload.function_configs) ? payload.function_configs : [];
  const models = [];
  const channels = new Map();

  // A model listed on both channels is NOT interchangeable between them. The
  // `solo_work_lite` entry exposes only the `__dev` tier (200K, and its
  // `max_mode` is false), while the same model on `solo_agent_remote` carries a
  // `__max` tier with a 1M window. Picking whichever channel the list happened to
  // visit first cost 22 models ~5x their real context. So collect every candidate
  // first, then keep the widest one per model.
  /** @type {Map<string, { model: object, channel: string }>} */
  const best = new Map();
  const consider = (entry, channelName) => {
    const model = normalizeTraeCnModel(entry, channelName);
    if (!model) return;
    const prev = best.get(model.id);
    // Tie-break on channel priority so the result is stable across catalog orders.
    const rank = (c) => {
      const i = TRAE_CN_CHANNELS.indexOf(c);
      return i === -1 ? TRAE_CN_CHANNELS.length : i;
    };
    if (!prev || (model.contextWindow || 0) > (prev.model.contextWindow || 0) ||
        ((model.contextWindow || 0) === (prev.model.contextWindow || 0) &&
         rank(channelName) < rank(prev.channel))) {
      best.set(model.id, { model, channel: channelName });
    }
  };

  for (const channelName of TRAE_CN_CHANNELS) {
    const group = groups.find((g) => String(g?.function || "").trim() === channelName);
    if (!group) continue;
    for (const entry of Array.isArray(group.config_info_list) ? group.config_info_list : []) {
      consider(entry, channelName);
    }
  }

  // Channels that were present in the response but not in the priority list —
  // still usable, appended after the known ones so nothing is silently dropped.
  for (const group of groups) {
    const channelName = String(group?.function || "").trim();
    if (!channelName || TRAE_CN_CHANNELS.includes(channelName)) continue;
    for (const entry of Array.isArray(group.config_info_list) ? group.config_info_list : []) {
      consider(entry, channelName);
    }
  }

  for (const [id, { model, channel }] of best) {
    models.push(model);
    channels.set(id, channel);
  }

  if (models.length === 0) return null;

  // On intl, most catalog entries answer `1005 {"plan":N}` — a subscription-tier
  // gate, not a transient failure. Presenting them as selectable models means every
  // pick on them fails, so the usable set is filtered to what was verified to answer
  // on a free account. CN has no such gate, so this only applies to intl.
  let usable = models;
  if (options.variant === "intl") {
    const allowed = new Set(TRAE_VARIANTS.intl.usableModelIds || []);
    usable = models.filter((m) => allowed.has(m.id));
  }
  if (usable.length === 0) return null;

  for (const [id, ch] of channels) channelByModel.set(id, ch);

  const entry = { expiresAt: Date.now() + CACHE_TTL_MS, models: usable, channels };
  catalogCache.set(key, entry);
  return entry;
}

/**
 * Which channel serves a model.
 *
 * Falls back to the first configured channel when the catalog has not been
 * fetched — callers that resolve the catalog first get the right answer, and the
 * fallback keeps a plain chat request working without a catalog round-trip.
 */
export function resolveTraeCnChannel(model) {
  const id = String(model || "").trim();
  if (!id) return TRAE_CN_CHANNELS[0];
  return channelByModel.get(id) || TRAE_CN_CHANNELS[0];
}

export function clearTraeCnModelCache() {
  catalogCache.clear();
  channelByModel.clear();
}
