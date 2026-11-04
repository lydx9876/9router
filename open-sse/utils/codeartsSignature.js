import crypto from "node:crypto";

/**
 * 华为云 CodeArts（码道 / CodeArts Doer）IAM 请求签名。
 *
 * 与 AWS SigV4 同族但有两处关键差异，抄 AWS 的实现会签错：
 *
 *  1. Authorization 用 `Access=<AK>` 而不是 `Credential=<AK>/<scope>`；
 *     credential scope 只有日期和 host，**没有 region、没有 service**。
 *  2. payload hash 恒为字面量 `UNSIGNED-PAYLOAD`（请求体不参与签名）。
 *
 * 已用官方 CodeArts Doer CLI 的真实请求逐字节比对验证：
 * canonicalRequestHash 与 signature 均与 CLI 日志一致。
 *
 * 官方 CLI 走的是 SM2 国密加密的 /api/v2/chat/completions，但密钥协商端点
 * /api/v1/security/key-exchange 在 cn-north-4 返回 404，CLI 会降级为明文，
 * 所以这里不需要实现国密加解密。
 */

const ALGORITHM = "SDK-HMAC-SHA256";
const PAYLOAD_HASH = "UNSIGNED-PAYLOAD";

/** RFC 3986 percent-encoding：encodeURIComponent 之外还要转义 !'()* */
export function escapeUri(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(payload) {
  return crypto.createHash("sha256").update(payload ?? "", "utf8").digest("hex");
}

function hmacHex(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/** "20261102T025146Z" */
function formatAmzDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * 规范化 URI：每个 path segment 单独 encode，并且**末尾补一个斜杠**。
 *
 * 末尾斜杠是 CodeArts 的硬性要求 —— 官方 CLI 签的是
 * "/api/v1/security/key-exchange/"（带斜杠），而实际请求路径没有。
 * 少这个斜杠服务端一律报 signature fail。
 */
function canonicalUri(pathname) {
  const encoded = String(pathname || "/")
    .split("/")
    .map((seg) => escapeUri(seg))
    .join("/");
  return encoded.endsWith("/") ? encoded : `${encoded}/`;
}

/**
 * 生成 CodeArts 签名头。
 *
 * @param {object} opts
 * @param {string} opts.method        HTTP 方法（当前只有 POST）
 * @param {string} opts.url           完整 URL（含 protocol/host/path）
 * @param {string} opts.accessKeyId   AK
 * @param {string} opts.secretAccessKey SK
 * @param {string} [opts.securityToken]  临时凭证的 token；长期 AK/SK 时留空
 * @param {string} [opts.contentType]    默认 application/json
 * @param {Date}   [opts.date]           签名时间，默认当前时间
 * @returns {Record<string,string>} 可直接并入请求头的字段
 */
export function signCodeArtsRequest({
  method = "POST",
  url,
  accessKeyId,
  secretAccessKey,
  securityToken = "",
  contentType = "application/json",
  date = new Date(),
}) {
  if (!url) throw new Error("signCodeArtsRequest: url is required");
  if (!accessKeyId) throw new Error("signCodeArtsRequest: accessKeyId is required");
  if (!secretAccessKey) throw new Error("signCodeArtsRequest: secretAccessKey is required");

  const parsed = new URL(url);
  const amzDate = formatAmzDate(date);

  const signedHeaders = {
    "Content-Type": contentType,
    "X-Sdk-Content-Sha256": PAYLOAD_HASH,
    "X-Security-Token": securityToken || "",
    "X-Sdk-Date": amzDate,
    Host: parsed.host,
  };

  const names = Object.keys(signedHeaders).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  const signedHeaderNames = names.map((n) => n.toLowerCase()).join(";");
  const canonicalHeaders = names
    .map((n) => `${n.toLowerCase()}:${signedHeaders[n]}\n`)
    .join("");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(parsed.pathname),
    "", // query string — CodeArts requests carry none
    canonicalHeaders,
    signedHeaderNames,
    PAYLOAD_HASH,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmacHex(secretAccessKey, stringToSign);

  return {
    "Content-Type": contentType,
    "X-Sdk-Content-Sha256": PAYLOAD_HASH,
    "X-Security-Token": securityToken || "",
    "X-Sdk-Date": amzDate,
    Host: parsed.host,
    Authorization: `${ALGORITHM} Access=${accessKeyId}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
  };
}
