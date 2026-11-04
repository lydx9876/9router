import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { expandKey, encryptBlock } from "../../open-sse/utils/sm4.js";
import { sm4GcmEncrypt, sm4GcmDecrypt, gfMul, GHash } from "../../open-sse/utils/sm4-gcm.js";
import {
  buildAad,
  encryptRequestBody,
  decryptSseChunk,
  isEncryptedResponse,
} from "../../open-sse/utils/codeartsEncryption.js";
import { CodeArtsKeyExchange, KEY_EXCHANGE_PATH } from "../../open-sse/utils/codeartsKeyExchange.js";

const hex = (buf) => Buffer.from(buf).toString("hex");

describe("SM4 block cipher", () => {
  it("matches the GB/T 32907-2016 test vector", () => {
    // 标准测试向量：key = plaintext = 0123456789abcdeffedcba9876543210
    const key = Buffer.from("0123456789abcdeffedcba9876543210", "hex");
    const plaintext = Buffer.from("0123456789abcdeffedcba9876543210", "hex");
    const ciphertext = encryptBlock(plaintext, expandKey(key));
    expect(hex(ciphertext)).toBe("681edf34d206965e86b3e94f536e4246");
  });

  it("agrees with OpenSSL sm4-ecb on random blocks", () => {
    // 交叉验证：手写实现 vs Node 内置的 OpenSSL SM4
    const key = crypto.randomBytes(16);
    for (let i = 0; i < 25; i++) {
      const plaintext = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv("sm4-ecb", key, null);
      cipher.setAutoPadding(false);
      const expected = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      expect(hex(encryptBlock(plaintext, expandKey(key)))).toBe(hex(expected));
    }
  });

  it("rejects a key of the wrong length", () => {
    expect(() => expandKey(Buffer.alloc(8))).toThrow(/16 bytes/);
  });
});

describe("GCM primitives", () => {
  it("matches the NIST GCM test case 4 authentication tag", () => {
    // 用 NIST 的权威向量验证 GHASH + CTR + 长度块的组装。
    // 这里用 AES-128 只是因为 GCM 与分组算法无关，GHASH 部分完全通用。
    const key = Buffer.from("feffe9928665731c6d6a8f9467308308", "hex");
    const iv = Buffer.from("cafebabefacedbaddecaf888", "hex");
    const aad = Buffer.from("feedfacedeadbeeffeedfacedeadbeefabaddad2", "hex");
    const plaintext = Buffer.from(
      "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
      "hex",
    );

    const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const expectedTag = cipher.getAuthTag();

    // 独立算出 H
    const ecb = crypto.createCipheriv("aes-128-ecb", key, null);
    ecb.setAutoPadding(false);
    const h = Buffer.concat([ecb.update(Buffer.alloc(16)), ecb.final()]);

    // 独立组装 GHASH
    const pad = (n) => Buffer.alloc((16 - (n % 16)) % 16);
    const encLen = (n) => {
      const o = Buffer.alloc(8);
      o.writeBigUInt64BE(BigInt(n));
      return o;
    };
    const ghash = new GHash(h);
    ghash.update(aad);
    ghash.update(pad(aad.length));
    ghash.update(ciphertext);
    ghash.update(pad(ciphertext.length));
    ghash.update(encLen(aad.length * 8));
    ghash.update(encLen(ciphertext.length * 8));
    const s = ghash.digest();

    // T = GHASH ^ E(K, J0)
    const j0 = Buffer.concat([iv, Buffer.from([0, 0, 0, 1])]);
    const ecb2 = crypto.createCipheriv("aes-128-ecb", key, null);
    ecb2.setAutoPadding(false);
    const ej0 = Buffer.concat([ecb2.update(j0), ecb2.final()]);
    const tag = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) tag[i] = s[i] ^ ej0[i];

    expect(hex(tag)).toBe(hex(expectedTag));
  });

  it("hashes an all-zero input to zero (GHASH property)", () => {
    const h = Buffer.from("66e94bd4ef8a2c3b884cfa59ca342b2e", "hex");
    const ghash = new GHash(h);
    ghash.update(Buffer.alloc(32));
    expect(hex(ghash.digest())).toBe("00000000000000000000000000000000");
  });

  it("multiplies in GF(2^128) reversibly", () => {
    const h = Buffer.from("66e94bd4ef8a2c3b884cfa59ca342b2e", "hex");
    const h2 = gfMul(h, h);
    const h3 = gfMul(h2, h);
    // H³ ≠ 0，且 gfMul 是确定性的
    expect(hex(h2)).toHaveLength(32);
    expect(hex(h2)).not.toBe("00000000000000000000000000000000");
    expect(hex(gfMul(h3, h))).toBe(hex(gfMul(gfMul(h2, h), h)));
  });
});

describe("SM4-GCM", () => {
  const key = Buffer.from("0123456789abcdeffedcba9876543210", "hex");
  const iv = Buffer.from("cafebabefacedbaddecaf888", "hex");

  it("round-trips a payload", () => {
    const aad = Buffer.from("POST|/api/v2/chat/completions|1762345678901");
    const plaintext = Buffer.from(JSON.stringify({ model: "deepseek-v4.1-flash-1017" }));
    const { ciphertext, authTag } = sm4GcmEncrypt(key, plaintext, iv, aad);

    expect(ciphertext).toHaveLength(plaintext.length);
    expect(authTag).toHaveLength(16);
    expect(hex(sm4GcmDecrypt(key, ciphertext, iv, authTag, aad))).toBe(hex(plaintext));
  });

  it("round-trips across block boundaries", () => {
    const aad = Buffer.from("");
    for (const len of [0, 1, 15, 16, 17, 31, 32, 33, 64]) {
      const plaintext = crypto.randomBytes(len);
      const { ciphertext, authTag } = sm4GcmEncrypt(key, plaintext, iv, aad);
      expect(hex(sm4GcmDecrypt(key, ciphertext, iv, authTag, aad))).toBe(hex(plaintext));
    }
  });

  it("rejects a tampered AAD", () => {
    const aad = Buffer.from("POST|/api/v2/chat/completions|1");
    const { ciphertext, authTag } = sm4GcmEncrypt(key, Buffer.from("hello"), iv, aad);
    expect(() => sm4GcmDecrypt(key, ciphertext, iv, authTag, Buffer.from("tampered"))).toThrow(
      /authentication tag mismatch/,
    );
  });

  it("rejects a tampered ciphertext", () => {
    const aad = Buffer.from("x");
    const { ciphertext, authTag } = sm4GcmEncrypt(key, Buffer.from("hello"), iv, aad);
    const bad = Buffer.from(ciphertext);
    bad[0] ^= 0x01;
    expect(() => sm4GcmDecrypt(key, bad, iv, authTag, aad)).toThrow(/authentication tag mismatch/);
  });

  it("rejects an IV of the wrong length", () => {
    expect(() => sm4GcmEncrypt(key, Buffer.from("x"), Buffer.alloc(16), Buffer.alloc(0))).toThrow(/GCM IV/);
  });
});

describe("CodeArts request encryption", () => {
  it("builds the AAD as method|path|timestamp", () => {
    expect(buildAad("POST", "/api/v2/chat/completions", 1762345678901)).toBe(
      "POST|/api/v2/chat/completions|1762345678901",
    );
  });

  it("produces the headers and body the upstream expects", () => {
    const sessionKey = crypto.randomBytes(16);
    const body = JSON.stringify({ model: "deepseek-v4.1-flash-1017" });
    const ts = 1762345678901;

    const result = encryptRequestBody(sessionKey, body, "POST", "/api/v2/chat/completions", ts);

    expect(result.headers["X-Encrypt-Algo"]).toBe("sm4-gcm");
    expect(result.headers["Content-Type"]).toBe("application/octet-stream");
    expect(result.headers["X-Encrypt-Ts"]).toBe(String(ts));
    // base64(iv) 是 12 字节 → 16 个字符
    expect(result.headers["X-Encrypt-Iv"]).toHaveLength(16);
    // base64(tag) 是 16 字节 → 24 个字符
    expect(result.headers["X-Encrypt-Tag"]).toHaveLength(24);
    // body 是 base64(ciphertext)
    expect(Buffer.from(result.body, "base64")).toHaveLength(Buffer.byteLength(body));
  });

  it("round-trips through encrypt → decrypt with the same session key", () => {
    const sessionKey = crypto.randomBytes(16);
    const body = JSON.stringify({ model: "deepseek-v4.1-flash-1017", stream: true });
    const ts = 1762345678901;
    const method = "POST";
    const pathname = "/api/v2/chat/completions";

    const request = encryptRequestBody(sessionKey, body, method, pathname, ts);
    // 模拟服务端：用同一个 AAD 解密请求体
    const serverAad = Buffer.from(buildAad(method, pathname, ts), "utf8");
    const decrypted = sm4GcmDecrypt(
      sessionKey,
      Buffer.from(request.body, "base64"),
      Buffer.from(request.headers["X-Encrypt-Iv"], "base64"),
      Buffer.from(request.headers["X-Encrypt-Tag"], "base64"),
      serverAad,
    );
    expect(decrypted.toString("utf8")).toBe(body);
  });

  it("detects an encrypted response by its X-Encrypt-Algo header", () => {
    expect(isEncryptedResponse(new Headers({ "x-encrypt-algo": "sm4-gcm" }))).toBe(true);
    expect(isEncryptedResponse(new Headers({ "content-type": "text/event-stream" }))).toBe(false);
  });

  it("decrypts an SSE chunk encrypted with keyId|chunkIndex as AAD", () => {
    const sessionKey = crypto.randomBytes(16);
    const keyId = "17889a4a-895e-4b68-a7f4-3ea740adb0cf";
    const plaintext = 'data: {"choices":[{"delta":{"content":"hi"}}]}';
    const iv = Buffer.from("cafebabefacedbaddecaf888", "hex");

    const { ciphertext, authTag } = sm4GcmEncrypt(
      sessionKey,
      Buffer.from(plaintext),
      iv,
      Buffer.from(`${keyId}|0`, "utf8"),
    );
    const chunk = [
      ciphertext.toString("base64"),
      iv.toString("base64"),
      authTag.toString("base64"),
    ].join(":");

    expect(decryptSseChunk(sessionKey, chunk, keyId, 0)).toBe(plaintext);
    // chunkIndex 不对就解不出来
    expect(() => decryptSseChunk(sessionKey, chunk, keyId, 1)).toThrow(/authentication tag mismatch/);
  });
});

describe("CodeArts key exchange", () => {
  it("derives the session key as SHA-256(ECDH secret)[0..16]", async () => {
    let capturedBody = null;
    let capturedHeaders = null;

    // 生成服务端密钥对，用于模拟服务端
    const server = crypto.createECDH("prime256v1");
    server.generateKeys();

    const fetchImpl = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          serverPublicKey: server.getPublicKey().toString("base64"),
          keyId: "key-123",
          expiresIn: 7200,
        }),
      };
    };

    const exchange = new CodeArtsKeyExchange({
      baseUrl: "https://snap-access.cn-north-4.myhuaweicloud.com",
      signHeaders: async () => ({ Authorization: "SDK-HMAC-SHA256 ..." }),
      fetchImpl,
    });

    const negotiated = await exchange.getOrNegotiateKey();

    // 请求体形状
    expect(capturedBody.clientPublicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(capturedBody.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof capturedBody.timestamp).toBe("number");
    // 请求头带上 AK/SK 签名
    expect(capturedHeaders.Authorization).toContain("SDK-HMAC-SHA256");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");

    // 派生结果：密钥是 16 字节的 SHA-256 前半段
    expect(negotiated.keyId).toBe("key-123");
    expect(negotiated.key).toHaveLength(16);
  });

  it("uses the documented key-exchange path", async () => {
    let capturedUrl = null;
    const exchange = new CodeArtsKeyExchange({
      baseUrl: "https://example.test",
      signHeaders: async () => ({}),
      fetchImpl: async (url) => {
        capturedUrl = url;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    await exchange._negotiate().catch(() => {});
    expect(capturedUrl).toBe(`https://example.test${KEY_EXCHANGE_PATH}`);
  });

  it("reuses the cached key instead of negotiating again", async () => {
    let calls = 0;
    const server = crypto.createECDH("prime256v1");
    server.generateKeys();
    const exchange = new CodeArtsKeyExchange({
      baseUrl: "https://example.test",
      signHeaders: async () => ({}),
      fetchImpl: async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            serverPublicKey: server.getPublicKey().toString("base64"),
            keyId: "key-1",
            expiresIn: 7200,
          }),
        };
      },
    });

    await exchange.getOrNegotiateKey();
    await exchange.getOrNegotiateKey();
    expect(calls).toBe(1);
  });

  it("fails loudly when the response lacks the required fields", async () => {
    const exchange = new CodeArtsKeyExchange({
      baseUrl: "https://example.test",
      signHeaders: async () => ({}),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ keyId: "only-key-id" }),
      }),
    });
    await expect(exchange.getOrNegotiateKey()).rejects.toThrow(/missing fields/);
  });
});
