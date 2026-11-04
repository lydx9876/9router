import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeArtsExecutor } from "../../open-sse/executors/codearts-cn.js";
import { sm4GcmDecrypt } from "../../open-sse/utils/sm4-gcm.js";
import { buildAad, decryptSseChunk } from "../../open-sse/utils/codeartsEncryption.js";

const AK = "AKIDEXAMPLE";
const SK = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

const CHAT_URL = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";

function credentials() {
  return {
    provider: "codearts-cn",
    providerSpecificData: { accessKeyId: AK, secretAccessKey: SK },
  };
}

describe("CodeArtsExecutor encrypted request", () => {
  const originalEnv = process.env.CODEARTS_ENABLE_ENCRYPTED_BODY;

  beforeEach(() => {
    process.env.CODEARTS_ENABLE_ENCRYPTED_BODY = "1";
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CODEARTS_ENABLE_ENCRYPTED_BODY;
    else process.env.CODEARTS_ENABLE_ENCRYPTED_BODY = originalEnv;
  });

  it("refuses to send a plaintext body when encryption is off", async () => {
    delete process.env.CODEARTS_ENABLE_ENCRYPTED_BODY;
    const executor = new CodeArtsExecutor();
    await expect(
      executor.prepareOutgoingRequest({
        headers: {},
        bodyStr: "{}",
        url: CHAT_URL,
        model: "deepseek-v4.1-flash-1017",
        credentials: credentials(),
        stream: true,
      }),
    ).rejects.toThrow(/SM4-GCM/);
  });

  it("encrypts the body, adds the X-Encrypt headers and re-signs", async () => {
    const executor = new CodeArtsExecutor();

    // 拦截 fetch：key-exchange 返回一把我们自己控制的密钥
    const serverEcdh = (await import("node:crypto")).createECDH("prime256v1");
    serverEcdh.generateKeys();

    let capturedRequest = null;
    let capturedKeyExchange = null;

    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).includes("/api/v1/security/key-exchange")) {
        capturedKeyExchange = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            serverPublicKey: serverEcdh.getPublicKey().toString("base64"),
            keyId: "key-abc",
            expiresIn: 7200,
          }),
        };
      }
      capturedRequest = init;
      return { ok: true, status: 200, headers: new Headers(), text: async () => "" };
    });

    // 让协商器用我们的 fetch
    executor.getKeyExchange = function getKeyExchange(baseUrl, creds) {
      if (!this._exchange) {
        this._exchange = new (require("../../open-sse/utils/codeartsKeyExchange.js").CodeArtsKeyExchange)({
          baseUrl,
          signHeaders: async (method, url, contentType) =>
            executor.signFor(creds, method, url, contentType),
          fetchImpl,
        });
      }
      return this._exchange;
    };

    const bodyStr = JSON.stringify({ model: "deepseek-v4.1-flash-1017", messages: [] });
    const result = await executor.prepareOutgoingRequest({
      headers: { "Content-Type": "application/json", "x-ot-client-type": "CLI" },
      bodyStr,
      url: CHAT_URL,
      model: "deepseek-v4.1-flash-1017",
      credentials: credentials(),
      stream: true,
    });

    // 加密头齐了
    expect(result.headers["X-Encrypt-Algo"]).toBe("sm4-gcm");
    expect(result.headers["X-Encrypt-Key-Id"]).toBe("key-abc");
    expect(result.headers["X-Encrypt-Iv"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(result.headers["X-Encrypt-Tag"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(result.headers["X-Encrypt-Ts"]).toMatch(/^\d+$/);
    // Content-Type 换成了 octet-stream
    expect(result.headers["Content-Type"]).toBe("application/octet-stream");
    // Authorization 是重新算的：SignedHeaders 里带上 content-type，
    // 而 content-type 的值不进签名头本身，所以要验证签名确实随 content-type 变了。
    expect(result.headers.Authorization).toContain("SignedHeaders=content-type");
    expect(result.headers.Authorization).not.toBe(
      executor.signFor(credentials(), "POST", CHAT_URL, "application/json").Authorization,
    );

    // body 是 base64(密文)。GCM 是流式模式，密文与明文**等长**
    // （IV 和 tag 单独放在请求头里，不占 body）。
    const ciphertext = Buffer.from(result.body, "base64");
    expect(ciphertext.length).toBe(Buffer.byteLength(bodyStr));

    // key-exchange 本身是用 AK/SK 签过名的
    expect(capturedKeyExchange.headers.Authorization).toContain("SDK-HMAC-SHA256");
  });

  it("decrypts an encrypted SSE stream chunk by chunk", async () => {
    const executor = new CodeArtsExecutor();
    const crypto = await import("node:crypto");
    const { sm4GcmEncrypt } = await import("../../open-sse/utils/sm4-gcm.js");

    const sessionKey = crypto.randomBytes(16);
    const keyId = "17889a4a-895e-4b68-a7f4-3ea740adb0cf";
    const plaintexts = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{"content":"世界"}}]}',
    ];

    // CLI 的分块格式：base64(ct):base64(iv):base64(tag)，AAD = keyId|index
    const encryptedChunks = plaintexts.map((plain, index) => {
      const iv = crypto.randomBytes(12);
      const { ciphertext, authTag } = sm4GcmEncrypt(
        sessionKey,
        Buffer.from(plain),
        iv,
        Buffer.from(`${keyId}|${index}`, "utf8"),
      );
      return [
        ciphertext.toString("base64"),
        iv.toString("base64"),
        authTag.toString("base64"),
      ].join(":");
    });

    executor.getKeyExchange = () => ({
      getOrNegotiateKey: async () => ({ keyId, key: sessionKey, expiresAt: Date.now() + 60000 }),
    });

    const response = new Response(encryptedChunks.join("\n\n") + "\n\n", {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Encrypt-Algo": "sm4-gcm",
        "X-Encrypt-Key-Id": keyId,
      },
    });

    const out = await executor.transformUpstreamResponse(response, {
      url: CHAT_URL,
      credentials: credentials(),
    });

    expect(out.headers.get("X-Encrypt-Algo")).toBeNull();
    expect(out.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await out.text();
    for (const plain of plaintexts) {
      expect(text).toContain(plain);
    }
  });

  it("rejects a malformed encrypted chunk", () => {
    const sessionKey = Buffer.alloc(16);
    expect(() => decryptSseChunk(sessionKey, "only-one-field", "kid", 0)).toThrow(
      /expected 3 fields/,
    );
  });

  it("uses keyId|chunkIndex as the response AAD", () => {
    const crypto = require("node:crypto");
    const { sm4GcmEncrypt } = require("../../open-sse/utils/sm4-gcm.js");
    const sessionKey = crypto.randomBytes(16);
    const keyId = "kid-1";
    const iv = crypto.randomBytes(12);
    const plain = "hello";

    const { ciphertext, authTag } = sm4GcmEncrypt(
      sessionKey,
      Buffer.from(plain),
      iv,
      Buffer.from(`${keyId}|0`, "utf8"),
    );
    const chunk = [
      ciphertext.toString("base64"),
      iv.toString("base64"),
      authTag.toString("base64"),
    ].join(":");

    expect(decryptSseChunk(sessionKey, chunk, keyId, 0)).toBe(plain);
    // 换 chunkIndex 应该解不出来（tag 校验失败）
    expect(() => decryptSseChunk(sessionKey, chunk, keyId, 1)).toThrow(/authentication tag mismatch/);
  });

  it("passes a plaintext response through untouched", async () => {
    const executor = new CodeArtsExecutor();
    const response = new Response("data: ok\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const out = await executor.transformUpstreamResponse(response, {
      url: CHAT_URL,
      credentials: credentials(),
    });
    expect(await out.text()).toBe("data: ok\n\n");
  });
});
