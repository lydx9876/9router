'use strict';

/**
 * 码道 CodeArts 的 SM4-GCM 会话密钥协商。
 *
 * 官方 CLI 的 encrypting-fetch 在发加密请求前会先协商一把会话密钥：
 *
 *   POST {baseUrl}/api/v1/security/key-exchange
 *     body: { clientPublicKey, sessionId, timestamp }
 *     headers: AK/SK 签名（Content-Type: application/json）
 *     resp:   { serverPublicKey, keyId, expiresIn }
 *
 * 双方用 ECDH（prime256v1）得到共享密钥，再派生 SM4 密钥：
 *
 *   sessionKey = SHA-256(ecdh.computeSecret(serverPublicKey))[0..16]
 *
 * 密钥有 TTL，CLI 会缓存并在临近过期时重新协商（提前 5 分钟续期）。
 */

const { createHash, createECDH, randomBytes } = require("crypto");

/** CLI 用的密钥协商路径（相对 baseUrl） */
const KEY_EXCHANGE_PATH = "/api/v1/security/key-exchange";

/** 加密算法标识 —— 放进 X-Encrypt-Algo 头 */
const ENCRYPT_ALGO = "sm4-gcm";

/**
 * 密钥的缓存时长（秒）。
 *
 * CLI 的默认 keyRefreshInterval 是 3600（1 小时）。
 * 服务端返回的 expiresIn 是 7200（2 小时），这里取两者中更短的一个，
 * 避免密钥还在用就过期。
 */
const KEY_TTL_SECONDS = 3600;

/**
 * 续期提前量（毫秒）。
 *
 * CLI 在密钥剩余寿命不足 5 分钟时就重新协商 —— 请求飞出去之前密钥就过期
 * 是很难排查的故障，宁可多握手一次。
 */
const KEY_RENEW_MARGIN_MS = 300000;

/**
 * 客户端的密钥协商器。
 *
 * 持有当前会话密钥，按需续期；同一个 baseUrl 复用同一个协商器实例，
 * 这样连续请求不会每次都重新协商。
 */
class CodeArtsKeyExchange {
  /**
   * @param {object} options
   * @param {string} options.baseUrl 上游 baseUrl
   * @param {Function} options.signHeaders 签名函数：(method, url, contentType) => Promise<object>
   * @param {Function} [options.fetchImpl] fetch 实现（便于测试）
   * @param {number} [options.ttlSeconds] 密钥缓存时长（秒）
   */
  constructor({ baseUrl, signHeaders, fetchImpl, ttlSeconds = KEY_TTL_SECONDS }) {
    this.baseUrl = baseUrl;
    this.signHeaders = signHeaders;
    this.fetchImpl = fetchImpl || globalThis.fetch.bind(globalThis);
    this.ttlSeconds = ttlSeconds;

    /** @type {{keyId: string, key: Buffer, expiresAt: number} | null} */
    this.current = null;
    /** @type {Promise<{keyId: string, key: Buffer, expiresAt: number}> | null} */
    this.pending = null;
  }

  /**
   * 拿到可用的会话密钥，必要时先协商一把。
   *
   * @returns {Promise<{keyId: string, key: Buffer, expiresAt: number}>}
   */
  async getOrNegotiateKey() {
    // 提前 5 分钟视为过期 —— 与 CLI 的行为一致，避免请求发出时密钥刚好过期
    if (this.current && Date.now() < this.current.expiresAt - KEY_RENEW_MARGIN_MS) {
      return this.current;
    }

    // 并发请求共用同一次协商
    if (this.pending) return this.pending;

    this.pending = this._negotiate()
      .then((key) => {
        this.current = key;
        return key;
      })
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }

  /**
   * 执行一次密钥协商。
   *
   * @returns {Promise<{keyId: string, key: Buffer, expiresAt: number}>}
   */
  async _negotiate() {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const clientPublicKey = ecdh.getPublicKey().toString("base64");

    const sessionId = randomBytes(16).toString("hex");
    const timestamp = Date.now();
    const url = `${this.baseUrl}${KEY_EXCHANGE_PATH}`;

    const signed = await this.signHeaders("POST", url, "application/json");
    const headers = {
      ...(signed || {}),
      "Content-Type": "application/json",
    };

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientPublicKey, sessionId, timestamp }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`CodeArts key exchange failed: ${response.status} ${body.slice(0, 300)}`);
    }

    const payload = await response.json();
    if (!payload?.serverPublicKey || !payload?.keyId) {
      throw new Error(
        "CodeArts key exchange response missing fields: " +
        `serverPublicKey=${!!payload?.serverPublicKey} keyId=${!!payload?.keyId}`,
      );
    }

    // ECDH → 共享密钥 → SHA-256 前 16 字节 = SM4 密钥
    const sharedSecret = ecdh.computeSecret(Buffer.from(payload.serverPublicKey, "base64"));
    const key = createHash("sha256").update(sharedSecret).digest().subarray(0, 16);

    const expiresIn = Number(payload.expiresIn) > 0 ? Number(payload.expiresIn) : 7200;
    return {
      keyId: payload.keyId,
      key: Buffer.from(key),
      // 取服务端给的 TTL 与本地上限中更短的，避免用着一把半路过期的密钥
      expiresAt: Date.now() + Math.min(expiresIn, this.ttlSeconds) * 1000,
    };
  }

  /** 丢弃当前密钥（下次请求重新协商） */
  clearKey() {
    this.current = null;
  }

  /** @returns {string | null} 当前密钥的 id */
  getCurrentKeyId() {
    return this.current?.keyId ?? null;
  }
}

module.exports = {
  CodeArtsKeyExchange,
  KEY_EXCHANGE_PATH,
  ENCRYPT_ALGO,
};
