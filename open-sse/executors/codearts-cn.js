import { randomUUID } from "node:crypto";

import { DefaultExecutor } from "./default.js";
import { signCodeArtsRequest } from "../utils/codeartsSignature.js";
import { acquireCodeArtsSlot } from "../utils/codeartsConcurrency.js";

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
 * 是否启用真实的 chat 请求。
 *
 * 默认关闭：上游现在要求请求 body 经 SM4-GCM 加密（见本文件头的说明），
 * 而本实现还没补上那一步。开着会得到一个误导性的 401
 * 「verify ak sk signature fail」（签名本身是对的）。
 *
 * 等 SM4-GCM 补齐后，把这个开关反过来（或直接删掉判断）即可启用。
 * 配额接口（snap-manager 插件统计）不受影响，一直可用。
 */
function encryptedBodyEnabled() {
  return process.env.CODEARTS_ENABLE_ENCRYPTED_BODY === "1";
}

/**
 * CodeArtsExecutor — talks to 华为云码道 CodeArts Doer (huaweicloud-maas)
 *
 * 端点：https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
 *
 * ## ⚠️ 当前状态：AK/SK 直连不可用（缺少 SM4-GCM body 加密）
 *
 * 码道对客户端是 OpenAI 兼容的（官方 CLI 用 @ai-sdk/openai-compatible），
 * 鉴权不是 Bearer，而是华为云 IAM 的 SDK-HMAC-SHA256 签名：
 *
 *   Authorization: SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=..., Signature=...
 *
 * 签名每个请求都要重算（X-Sdk-Date 参与签名），所以放在 buildHeaders 里做，
 * 不能靠 registry 的静态 headers。
 *
 * 但完整的真实链路（从官方 CLI 日志 ~/.codeartsdoer/cli-data/log/ 提取）是：
 *
 *   1. AK/SK 签名 → POST /api/v1/security/key-exchange
 *      → 拿到会话密钥 keyId（expiresIn=7200）
 *   2. 请求 body 用 SM4-GCM 加密（密文比明文长 28 字节：12 IV + 16 tag）
 *   3. 用 AK/SK 签名**加密后**的请求，content-type: application/octet-stream
 *
 * 本实现完成了 1、3，**缺第 2 步**（SM4-GCM）。因此上游会对明文 body 的请求
 * 回答：
 *
 *   401 {"error_code":"APIG.0301","error_msg":"Incorrect IAM authentication information: verify ak sk signature fail"}
 *
 * ⚠️ 这个报错信息有误导性 —— 签名本身是对的（canonicalRequestHash 与官方 CLI
 * 逐字节一致，见 tests/unit/codearts-signature.test.js 的基准值），失败在服务端
 * 解密 body 上。
 *
 * 要补齐需要：ECDH(prime256v1) 密钥协商 + SM4-GCM（Node 只有 SM3，SM4 得靠
 * 第三方库，且 GCM 模式多半要手写）。故暂时保留本 provider 的签名 / 请求头 /
 * 并发闸门，待加密补齐后再启用。
 *
 * ## 已完成且可独立复用的部分
 *
 * - 签名：open-sse/utils/codeartsSignature.js（与官方 CLI 逐字节一致）
 * - 并发闸门：open-sse/utils/codeartsConcurrency.js
 *   （码道每账号只允许 3 个并发会话，超出返回 400 TM.00001041）
 * - 配额跟踪：open-sse/services/usage/codearts-cn.js
 *   （snap-manager 插件统计接口，用 AK/SK 就能调，**目前是实际可用的**）
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
  }

  /** 从 connection 的 providerSpecificData 里取 AK/SK。 */
  getCredentials(credentials) {
    const data = credentials?.providerSpecificData || {};
    const accessKeyId = String(data.accessKeyId || "").trim();
    const secretAccessKey = String(data.secretAccessKey || "").trim();
    const securityToken = String(data.securityToken || "").trim();
    return { accessKeyId, secretAccessKey, securityToken };
  }

  buildHeaders(credentials, stream = true, url = null, model = null, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);

    // 去掉默认的 Bearer —— 码道网关不认，只认 IAM 签名
    delete headers["Authorization"];
    delete headers["x-api-key"];

    const { accessKeyId, secretAccessKey, securityToken } = this.getCredentials(credentials);
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "codearts-cn requires accessKeyId and secretAccessKey in providerSpecificData " +
          "(华为云 AK/SK，参考 https://codearts.huaweicloud.com/portal/settings/cli-auth)",
      );
    }

    const signed = signCodeArtsRequest({
      method: "POST",
      url,
      accessKeyId,
      secretAccessKey,
      securityToken,
      contentType: "application/json",
    });

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
    headers["x-ot-session-id"] = `ses_${uuidNoDashes()}`;
    headers["user-session-id"] = headers["x-ot-session-id"];
    headers["x-ot-parent-session-id"] = "";
    headers["user-msg-id"] = "";
    headers["created-time"] = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    headers["model-id"] = model || "";
    headers["model-name"] = model || "";

    return headers;
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
  async execute(params) {
    const { model, body, stream, credentials, signal } = params;
    const { accessKeyId } = this.getCredentials(credentials);

    // 拿不到凭据时不排队 —— 让 buildHeaders 抛出带说明的错误
    if (!accessKeyId) {
      return super.execute(params);
    }

    // 上游现在要求 body 经 SM4-GCM 加密，尚未实现。在排队之前就报清楚，
    // 免得用户等完队拿到一个误导性的 “verify ak sk signature fail”。
    if (!encryptedBodyEnabled()) {
      throw new Error(
        "codearts-cn: chat requests are disabled because CodeArts now requires the request " +
          "body to be encrypted with SM4-GCM (after a key-exchange step). The IAM signing " +
          "is implemented and verified byte-for-byte against the official CLI, but the " +
          "encryption layer is not — upstream answers 401 \"verify ak sk signature fail\" " +
          "for plaintext bodies. Quota tracking (snap-manager plugin statistics) is " +
          "unaffected and works. Set CODEARTS_ENABLE_ENCRYPTED_BODY=1 once the " +
          "encryption layer lands.",
      );
    }

    const release = await acquireCodeArtsSlot(accessKeyId, { signal });
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

    // 加密未实现时无法用 chat 端点判定凭据 —— 别把 401 误报成“凭据无效”。
    if (!encryptedBodyEnabled()) {
      return {
        valid: false,
        error:
          "CodeArts chat is not ready: the request body must be encrypted with SM4-GCM " +
          "(after a key-exchange step), which is not implemented yet. The AK/SK pair cannot " +
          "be validated through the chat endpoint until then. Quota tracking works — use " +
          "the usage panel to confirm the credentials.",
      };
    }

    // 探测也占上游槽位。不排队的话，在账号满载时会拿到 400 并发错误，
    // 被误判成“凭据无效”。这里排队等待，超时则报“暂时无法验证”。
    let release;
    try {
      release = await acquireCodeArtsSlot(accessKeyId, { maxWaitMs: 45_000 });
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
