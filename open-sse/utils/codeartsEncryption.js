'use strict';

/**
 * 码道 CodeArts 的加密请求封装。
 *
 * 官方 CLI 的 encrypting-fetch 对发往 /api/v2/chat/completions 的请求做四件事：
 *
 *   1. 协商会话密钥（ECDH → SHA-256 前 16 字节）
 *   2. 用 SM4-GCM 加密 body，AAD = `${method}|${pathname}|${timestamp}`
 *   3. 加上 X-Encrypt-* 头，并用 AK/SK **重新签名**（Content-Type 变成
 *      application/octet-stream）
 *   4. body 发送 base64(ciphertext)
 *
 * 响应同样加密：响应头带 X-Encrypt-Algo / X-Encrypt-Key-Id，
 * 需要用同一把密钥解密后才能读。
 */

const { randomBytes } = require("crypto");
const { sm4GcmEncrypt, sm4GcmDecrypt } = require("./sm4-gcm.js");
const { ENCRYPT_ALGO } = require("./codeartsKeyExchange.js");

/**
 * 构造加密请求所需的 AAD。
 *
 * 官方 CLI 的格式是 `${method}|${pathname}|${timestamp}`，
 * 三者都参与认证 —— 路径或方法被改动都会导致服务端解密失败。
 *
 * @param {string} method HTTP 方法
 * @param {string} pathname URL 的 path 部分（不含 query）
 * @param {number} timestamp 毫秒时间戳
 * @returns {string}
 */
function buildAad(method, pathname, timestamp) {
  return `${method}|${pathname}|${timestamp}`;
}

/**
 * 把请求体加密成码道期望的形态。
 *
 * @param {Buffer} sessionKey 16 字节会话密钥
 * @param {string} body 明文 body
 * @param {string} method HTTP 方法
 * @param {string} pathname URL path
 * @param {number} timestamp 毫秒时间戳
 * @returns {{body: string, headers: object, iv: Buffer, authTag: Buffer}}
 */
function encryptRequestBody(sessionKey, body, method, pathname, timestamp) {
  const iv = randomBytes(12);
  const aad = Buffer.from(buildAad(method, pathname, timestamp), "utf8");
  const plaintext = Buffer.from(body, "utf8");

  const { ciphertext, authTag } = sm4GcmEncrypt(sessionKey, plaintext, iv, aad);

  return {
    // CLI 发送 base64(ciphertext)，不是原始字节。
    // ⚠️ ciphertext / authTag 是 Uint8Array —— Uint8Array.toString() 不支持
    // 编码参数，必须先转成 Buffer，否则会得到逗号分隔的十进制字符串。
    body: Buffer.from(ciphertext).toString("base64"),
    headers: {
      "X-Encrypt-Algo": ENCRYPT_ALGO,
      "X-Encrypt-Iv": Buffer.from(iv).toString("base64"),
      "X-Encrypt-Tag": Buffer.from(authTag).toString("base64"),
      "X-Encrypt-Ts": String(timestamp),
      "Content-Type": "application/octet-stream",
    },
    iv,
    authTag,
  };
}

/**
 * 解码一个加密的 SSE 分块。
 *
 * 上游把 SSE 流**逐块**加密，每块的格式是：
 *
 *   base64(ciphertext):base64(iv):base64(tag)
 *
 * （字段分隔符是冒号，块与块之间用空行分隔。）
 *
 * AAD 与请求侧不同：不是 `${method}|${path}|${ts}`，
 * 而是 `${keyId}|${chunkIndex}` —— chunkIndex 从 0 开始递增。
 *
 * @param {Buffer} sessionKey 16 字节会话密钥
 * @param {string} chunk 加密的分块文本
 * @param {string} keyId 会话密钥 id
 * @param {number} chunkIndex 分块序号（从 0 开始）
 * @returns {string} 明文
 */
function decryptSseChunk(sessionKey, chunk, keyId, chunkIndex) {
  const parts = chunk.split(":");
  if (parts.length !== 3) {
    throw new Error(
      `Invalid encrypted SSE chunk format: expected 3 fields, got ${parts.length}`,
    );
  }

  const ciphertext = Buffer.from(parts[0], "base64");
  const iv = Buffer.from(parts[1], "base64");
  const authTag = Buffer.from(parts[2], "base64");
  const aad = Buffer.from(`${keyId}|${chunkIndex}`, "utf8");

  return sm4GcmDecrypt(sessionKey, ciphertext, iv, authTag, aad).toString("utf8");
}

/**
 * 判断响应是否被加密。
 *
 * @param {Headers|object} headers
 * @returns {boolean}
 */
function isEncryptedResponse(headers) {
  const algo = typeof headers?.get === "function" ? headers.get("x-encrypt-algo") : headers?.["x-encrypt-algo"];
  return !!algo;
}

module.exports = {
  buildAad,
  encryptRequestBody,
  decryptSseChunk,
  isEncryptedResponse,
  ENCRYPT_ALGO,
};
