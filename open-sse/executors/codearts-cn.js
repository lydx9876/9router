import { randomUUID, createHash } from "node:crypto";

import { DefaultExecutor } from "./default.js";
import { signCodeArtsRequest } from "../utils/codeartsSignature.js";
import { acquireCodeArtsSlot } from "../utils/codeartsConcurrency.js";
import { CodeArtsKeyExchange } from "../utils/codeartsKeyExchange.js";
import { encryptRequestBody, decryptSseChunk, isEncryptedResponse } from "../utils/codeartsEncryption.js";

/**
 * CLI 的 trace/session id 用的是不带连字符的 uuid。
 *
 * 固定不变的头（app-id / x-ot-client-* 等）在 registry 的 transport.headers 里，
 * 这样 Custom Headers 面板能列出来、用户能改。
 */
function uuidNoDashes() {
  return randomUUID().replace(/-/g, "");
}

/**
 * 是否启用 SM4-GCM 加密的 chat 请求。
 *
 * 默认**开启** —— 加密链路已经用真实 AK/SK 对上游实测通过。
 * 设 CODEARTS_ENABLE_ENCRYPTED_BODY=0 可以关掉（关掉后上游会拒绝明文 body，
 * 报 401 "verify ak sk signature fail"，这个报错有误导性 —— 签名本身是对的）。
 *
 * 配额接口（snap-manager 插件统计）不走这里，一直可用。
 */
function encryptedBodyEnabled() {
  return process.env.CODEARTS_ENABLE_ENCRYPTED_BODY !== "0";
}

/**
 * CodeArtsExecutor — talks to 华为云码道 CodeArts Doer (huaweicloud-maas)
 *
 * 端点：https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
 *
 * ## 鉴权与加密
 *
 * 码道对客户端是 OpenAI 兼容的（官方 CLI 用 @ai-sdk/openai-compatible），
 * 鉴权不是 Bearer，而是华为云 IAM 的 SDK-HMAC-SHA256 签名：
 *
 *   Authorization: SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=..., Signature=...
 *
 * 签名每个请求都要重算（X-Sdk-Date 参与签名），所以放在 buildHeaders 里做，
 * 不能靠 registry 的静态 headers。
 *
 * 完整的真实链路（从官方 CLI 二进制提取）是：
 *
 *   1. AK/SK 签名 → POST /api/v1/security/key-exchange
 *      → ECDH(prime256v1) 协商出会话密钥
 *      → sessionKey = SHA-256(共享密钥)[0..16]，keyId 的 TTL 是 7200 秒
 *   2. 请求 body 用 SM4-GCM 加密
 *      AAD = `${method}|${pathname}|${timestamp}`
 *      密文比明文长 28 字节（12 IV + 16 tag），body 发送 base64(密文)
 *   3. 加上 X-Encrypt-Algo / -Key-Id / -Iv / -Tag / -Ts 五个头
 *   4. 用 AK/SK 签名**加密后**的请求，content-type: application/octet-stream
 *   5. 响应也是加密的：响应头带 X-Encrypt-Algo / -Key-Id / -Iv / -Tag，
 *      需要用同一把密钥解密
 *
 * 实现见：
 *   - 签名：open-sse/utils/codeartsSignature.js（与官方 CLI 逐字节一致）
 *   - 密钥协商：open-sse/utils/codeartsKeyExchange.js
 *   - SM4-GCM：open-sse/utils/sm4.js + open-sse/utils/sm4-gcm.js
 *     （Node / OpenSSL 都没有 sm4-gcm，GCM 模式是手写的；
 *      SM4 分组已用 GB/T 32907-2016 标准向量和 OpenSSL sm4-ecb 交叉验证）
 *
 * ## 并发限制
 *
 * 码道每账号只允许 3 个并发会话，超出返回 400 TM.00001041。
 * open-sse/utils/codeartsConcurrency.js 做本地闸门，
 * executor 的 computeRetryDelay 做退避重试。
 *
 * AK/SK 存在 connection 的 providerSpecificData 里：
 *   { accessKeyId, secretAccessKey, securityToken? }
 * 走 apikey 连接模式，apiKey 字段本身不用填（UI 上仍需一个非空值）。
 *
 * 请求头按官方 CodeArts Doer CLI 的形状补齐（CLI 内部叫 getInferhubHcHeaders）：
 * x-ot-* 系列是网关的调用方标识，app-id / is-need-queue 决定请求是否进排队。
 * 缺了它们网关仍会放行，但会丢掉 trace/session 关联，排查问题时分不清是
 * 哪个客户端发起的。CLI 在 AK/SK 模式下发的头见下（值取自 CLI 二进制）。
 */
export class CodeArtsExecutor extends DefaultExecutor {
  constructor() {
    super("codearts-cn");
    /** @type {Map<string, CodeArtsKeyExchange>} 按 baseUrl 缓存的密钥协商器 */
    this.keyExchanges = new Map();
  }

  /** 从 connection 的 providerSpecificData 里取 AK/SK。 */
  getCredentials(credentials) {
    const data = credentials?.providerSpecificData || {};
    const accessKeyId = String(data.accessKeyId || "").trim();
    const secretAccessKey = String(data.secretAccessKey || "").trim();
    const securityToken = String(data.securityToken || "").trim();
    return { accessKeyId, secretAccessKey, securityToken };
  }

  /**
   * 拿到（或创建）该 baseUrl 的密钥协商器。
   *
   * 复用同一个实例，连续请求就不会每次都重新握手 ——
   * 密钥的 TTL 是 3600 秒，提前 5 分钟自动续期。
   *
   * @param {string} baseUrl 上游 origin（不带路径）
   * @param {object} credentials
   * @returns {CodeArtsKeyExchange}
   */
  getKeyExchange(baseUrl, credentials) {
    const existing = this.keyExchanges.get(baseUrl);
    if (existing) return existing;

    const { accessKeyId, secretAccessKey, securityToken } = this.getCredentials(credentials);
    const exchange = new CodeArtsKeyExchange({
      baseUrl,
      signHeaders: async (method, url, contentType) =>
        signCodeArtsRequest({
          method,
          url,
          accessKeyId,
          secretAccessKey,
          securityToken,
          contentType,
        }),
    });
    this.keyExchanges.set(baseUrl, exchange);
    return exchange;
  }

  /**
   * 上游的 origin（scheme://host）。
   *
   * registry 的 transport.baseUrl 是**完整端点**
   * （https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions），
   * 而 key-exchange 是挂在同一主机根路径上的另一个端点
   * （/api/v1/security/key-exchange），所以要从 origin 拼，不能直接接路径。
   *
   * @returns {string}
   */
  getOrigin() {
    const base = this.getBaseUrls()[0] || this.config.baseUrl || "";
    try {
      return new URL(base).origin;
    } catch {
      return base.replace(/\/api\/.*$/, "");
    }
  }

  /** 签名的辅助（buildHeaders 与密钥协商共用） */
  signFor(credentials, method, url, contentType) {
    const { accessKeyId, secretAccessKey, securityToken } = this.getCredentials(credentials);
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "codearts-cn requires accessKeyId and secretAccessKey in providerSpecificData " +
          "(华为云 AK/SK，参考 https://codearts.huaweicloud.com/portal/settings/cli-auth)",
      );
    }
    return signCodeArtsRequest({
      method,
      url,
      accessKeyId,
      secretAccessKey,
      securityToken,
      contentType,
    });
  }

  buildHeaders(credentials, stream = true, url = null, model = null, body = null, providerSessionId = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body, providerSessionId);

    // 去掉默认的 Bearer —— 码道网关不认，只认 IAM 签名
    delete headers["Authorization"];
    delete headers["x-api-key"];

    const signed = this.signFor(credentials, "POST", url, "application/json");

    // 签名的头覆盖 registry 里的静态头（含 Host —— fetch 会自己设，但带上更贴近官方 CLI）
    Object.assign(headers, signed);

    // 每请求变化的头（registry 里放不了 —— 每次调用都得是新的）。
    // 值的形状取自官方 CLI 的 getInferhubHcHeaders：
    //   x-ot-*id = uuid 去连字符
    //   x-ot-session-id / user-session-id：CLI 用的是 "ses_..." 形式的会话 id，
    //     这里用同样的前缀，便于在上游日志里关联到同一次会话
    headers["x-ot-trace-id"] = uuidNoDashes();
    headers["x-ot-span-id"] = uuidNoDashes();
    headers["x-snap-traceid"] = uuidNoDashes();
    headers["x-ot-session-id"] = this.resolveUpstreamSessionId(providerSessionId);
    headers["user-session-id"] = headers["x-ot-session-id"];
    headers["x-ot-parent-session-id"] = "";
    headers["user-msg-id"] = "";
    headers["created-time"] = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    headers["model-id"] = model || "";
    headers["model-name"] = model || "";

    return headers;
  }

  /**
   * 推导上游的会话 id。
   *
   * ⚠️ 码道的「并发会话数已达上限(3个)」限的是**账号下同时活跃的不同
   * x-ot-session-id 的个数**，不是同时在飞的请求数。实测：
   *
   *   - 固定同一个 x-ot-session-id 连发 6 次 → 全部 200
   *   - 每次换一个新的 x-ot-session-id    → 第 4 个开始 400 TM.00001041
   *
   * 所以每次请求都生成新的 session id 会让「一次对话」很快占满 3 个槽位，
   * 客户端再发第 4 条就报并发超限 —— 而用户明明只有一个会话。
   *
   * 因此这里用 9router 的 providerSessionId（同一轮对话内稳定）派生，
   * 保证一轮对话只占一个上游会话。
   *
   * @param {string|null} providerSessionId
   * @returns {string} 形如 ses_<32 位 hex>
   */
  resolveUpstreamSessionId(providerSessionId) {
    const seed = String(providerSessionId || "").trim();
    if (!seed) {
      // 没有会话标识（例如直接调 executor）——退回随机，但同一个连接内保持稳定
      if (!this._fallbackSessionId) {
        this._fallbackSessionId = `ses_${uuidNoDashes()}`;
      }
      return this._fallbackSessionId;
    }
    // 派生成 32 位 hex，保持 CLI 的 "ses_" + 32 hex 形状
    const digest = createHash("sha256").update(`codearts-cn:${seed}`).digest("hex");
    return `ses_${digest.slice(0, 32)}`;
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    // 码道是 SSE 流式端点，非流式请求会被拒（同 codebuddy-cn 的处理）
    transformed.stream = true;
    return transformed;
  }

  /**
   * 遇到「并发会话数已达上限」时退避重试。
   *
   * 闸门只能抹平突发，无法精确知道上游槽位何时释放（实测释放时机在 60 秒
   * 量级，且难以测量）。所以真正的保险是这一层：上游返回
   *   400 {"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)…"}
   * 时，退避后重试，直到上游真的腾出槽位。
   *
   * 返回 false 表示 veto（放弃重试，直接把错误返回给客户端），
   * 返回 null 表示用 registry 里的默认退避时长。
   */
  async computeRetryDelay(response, attempt) {
    // 只对 400 且确实是并发超限才重试 —— 其他 400（参数错、签名错）重试无意义。
    if (response.status !== 400) return null;

    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch {
      return false;
    }
    if (!/并发会话数已达上限/.test(bodyText)) return false;

    // 退避：10s → 20s → 40s … 封顶 40s。最多 8 次（累计约 3 分钟），
    // 足够覆盖上游最长的槽位保留时间。
    if (attempt > 8) return false;
    return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), 40_000);
  }

  /**
   * 在上游调用前排队，等码道的并发槽位空出来。
   *
   * 码道对每个账号只允许 3 个并发会话，超出直接 400（TM.00001041）。
   * 槽位在上游侧还会滞留 20–30 秒，所以闸门既看“正在飞行中的请求”，
   * 也看“最近 30 秒内发起过的请求”——否则前一个请求一返回就放行下一个，
   * 而上游还没释放槽位，会被再拒一次。
   *
   * 闸门按 AK 分组：同一账号的多个连接共享 3 个槽位。
   */
  /**
   * 加密请求体并重新签名。
   *
   * 官方 CLI 的 encrypting-fetch 就是这么做的：
   *   1. 协商会话密钥（ECDH）
   *   2. SM4-GCM 加密 body，AAD = `${method}|${pathname}|${timestamp}`
   *   3. 加上 X-Encrypt-* 头
   *   4. 用 AK/SK 重新签名（Content-Type 变成 application/octet-stream）
   *   5. body 发 base64(密文)
   */
  async prepareOutgoingRequest({ headers, bodyStr, url, model, credentials, stream }) {
    if (!encryptedBodyEnabled()) {
      throw new Error(
        "codearts-cn: the encrypted request path is disabled " +
          "(CODEARTS_ENABLE_ENCRYPTED_BODY=0). CodeArts requires the request body to be " +
          "encrypted with SM4-GCM after a key-exchange step; a plaintext body is rejected " +
          "with a misleading 401 \"verify ak sk signature fail\".",
      );
    }

    const baseUrl = this.getOrigin();
    const exchange = this.getKeyExchange(baseUrl, credentials);
    const { key, keyId } = await exchange.getOrNegotiateKey();

    const parsed = new URL(url);
    const timestamp = Date.now();
    const method = "POST";

    const encrypted = encryptRequestBody(key, bodyStr, method, parsed.pathname, timestamp);

    // 重新签名 —— 签名的是加密后的请求，Content-Type 是 octet-stream
    const signed = this.signFor(credentials, method, url, "application/octet-stream");

    const finalHeaders = { ...headers };
    // 签名头覆盖旧值（旧的 Authorization 是按 application/json 签的，必须换掉）
    Object.assign(finalHeaders, signed);
    Object.assign(finalHeaders, encrypted.headers);
    // 密钥 id 告诉服务端用哪把密钥解密
    finalHeaders["X-Encrypt-Key-Id"] = keyId;

    return { headers: finalHeaders, body: encrypted.body };
  }

  /**
   * 解密上游的 SSE 响应。
   *
   * 码道把 SSE 流**逐块**加密：每块的格式是
   *
   *   base64(ciphertext):base64(iv):base64(tag)
   *
   * 块与块之间用空行分隔，每块有自己的 IV 和 tag，
   * AAD 是 `${keyId}|${chunkIndex}`（chunkIndex 从 0 开始）。
   *
   * 解密后把 X-Encrypt-* 头删掉、Content-Type 改回 text/event-stream。
   */
  async transformUpstreamResponse(response, { url, credentials }) {
    if (!encryptedBodyEnabled() || !isEncryptedResponse(response.headers)) {
      return response;
    }

    const baseUrl = this.getOrigin();
    const exchange = this.getKeyExchange(baseUrl, credentials);
    const { key, keyId } = await exchange.getOrNegotiateKey();

    const headers = new Headers(response.headers);
    headers.delete("X-Encrypt-Algo");
    headers.delete("X-Encrypt-Key-Id");
    headers.delete("X-Encrypt-Iv");
    headers.delete("X-Encrypt-Tag");
    headers.delete("X-Encrypt-Ts");
    headers.set("Content-Type", "text/event-stream");

    const body = response.body;
    if (!body) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // 逐块解密：累积到空行为止，然后解一块、吐一块
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let chunkIndex = 0;

    const stream = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // 末尾可能还有没跟空行的一���
            const rest = buffer.trim();
            if (rest) {
              const plain = decryptSseChunk(key, rest, keyId, chunkIndex++);
              controller.enqueue(encoder.encode(`${plain}\n\n`));
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          let emitted = false;
          for (const part of parts) {
            const text = part.trim();
            if (!text) continue;
            const plain = decryptSseChunk(key, text, keyId, chunkIndex++);
            controller.enqueue(encoder.encode(`${plain}\n\n`));
            emitted = true;
          }
          if (emitted) return;
        }
      },
      cancel(reason) {
        reader.cancel(reason);
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  async execute(params) {
    const { model, body, stream, credentials, signal, providerSessionId } = params;
    const { accessKeyId } = this.getCredentials(credentials);

    // 拿不到凭据时不排队 —— 让 buildHeaders 抛出带说明的错误
    if (!accessKeyId) {
      return super.execute(params);
    }

    // 上游要求 body 经 SM4-GCM 加密。加密链路在 prepareOutgoingRequest 里完成，
    // 这里只负责排队（拿不到凭据时不排队，让签名阶段报带说明的错误）。
    if (!encryptedBodyEnabled()) {
      throw new Error(
        "codearts-cn: the SM4-GCM encrypted request path is disabled " +
          "(CODEARTS_ENABLE_ENCRYPTED_BODY=0). Quota tracking (snap-manager plugin " +
          "statistics) is unaffected and works without it.",
      );
    }

    // 闸门按**上游 session id** 计数 —— 码道限的是账号下活跃的不同会话数，
    // 不是同时在飞的请求数。同一对话的串行请求因此不会互相排队。
    const upstreamSessionId = this.resolveUpstreamSessionId(providerSessionId);
    const release = await acquireCodeArtsSlot(accessKeyId, upstreamSessionId, { signal });
    try {
      const result = await super.execute(params);
      // 槽位必须等响应体读完才释放：码道的流式响应在调用方消费 body 时
      // 才真正结束，提前释放会让下一个请求撞上上游还没释放的槽位。
      result.response = this.wrapResponseBody(result.response, release);
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * 把 Response 的 body 包一层，在流结束 / 出错 / 取消时释放并发槽位。
   *
   * 非流式响应（body 为 null）直接释放。
   */
  wrapResponseBody(response, release) {
    if (!response?.body) {
      release();
      return response;
    }

    const reader = response.body.getReader();
    const released = { done: false };
    const releaseOnce = () => {
      if (released.done) return;
      released.done = true;
      release();
    };

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            releaseOnce();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          releaseOnce();
          controller.error(error);
        }
      },
      cancel(reason) {
        releaseOnce();
        try {
          reader.cancel(reason);
        } catch {
          /* 底层已关闭，忽略 */
        }
      },
    });

    // 用同状态码/头构造新 Response，body 换成被包裹的流
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * 连通性探测：发一个最小流式请求，看签名能否被网关接受。
   *
   * 不能用通用的 Bearer 探测 —— 码道网关只认 IAM 签名，Bearer 会得到 401，
   * 而签名错误会得到 "verify ak sk signature fail"，两者需要区分开：
   * 前者说明凭据对了但签名实现有问题，后者说明 AK/SK 本身不对。
   *
   * ⚠️ 注意：上游现在要求 body 经 SM4-GCM 加密，未实现前明文请求一律 401
   * 「verify ak sk signature fail」—— 这个信号**不能**用来判定凭据无效。
   * 所以探测在未启用加密时直接返回“功能未就绪”，而不是把 401 当成凭据错误。
   *
   * 参数形态对齐 probeBedrockCredentials(connection, fetchImpl)：连接对象里带
   * providerSpecificData，fetchImpl 让调用方注入代理。
   */
  async probeCredentials(connection = {}, fetchImpl = fetch) {
    const { accessKeyId, secretAccessKey, securityToken } = this.getCredentials(connection);
    if (!accessKeyId || !secretAccessKey) {
      return { valid: false, error: "accessKeyId and secretAccessKey are required" };
    }

    // 探测也占上游会话名额。不排队的话，在账号满载时会拿到 400 并发错误，
    // 被误判成“凭据无效”。这里排队等待，超时则报“暂时无法验证”。
    // 探测用自己的 session id —— 不能占用用户对话的名额。
    let release;
    try {
      release = await acquireCodeArtsSlot(
        accessKeyId,
        `probe_${this.resolveUpstreamSessionId(null)}`,
        { maxWaitMs: 45_000 },
      );
    } catch {
      return {
        valid: false,
        error: "CodeArts is busy (all concurrent sessions in use) — could not verify right now.",
      };
    }

    const url = this.config.baseUrl;
    const headers = this.buildHeaders(
      { provider: "codearts-cn", providerSpecificData: { accessKeyId, secretAccessKey, securityToken } },
      true,
      url,
      "deepseek-v4.1-flash-1017",
      {},
    );

    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "deepseek-v4.1-flash-1017",
          messages: [{ role: "user", content: "ping" }],
          stream: true,
          max_tokens: 1,
        }),
      });
      if (res.ok) return { valid: true, error: null };
      const text = await res.text().catch(() => "");
      if (/verify ak sk signature fail/i.test(text)) {
        return { valid: false, error: "Invalid AK/SK (signature rejected by CodeArts)" };
      }
      if (/并发会话数已达上限/.test(text)) {
        // 上游只是满了，凭据本身是好的
        return { valid: true, error: null };
      }
      return { valid: false, error: `CodeArts returned HTTP ${res.status}` };
    } catch (err) {
      return { valid: false, error: err?.message || "CodeArts probe failed" };
    } finally {
      // 探测已读完整个 body，槽位可以立即释放
      release();
    }
  }
}

export default CodeArtsExecutor;
