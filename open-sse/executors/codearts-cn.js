import { DefaultExecutor } from "./default.js";
import { signCodeArtsRequest } from "../utils/codeartsSignature.js";

/**
 * CodeArtsExecutor — talks to 华为云码道 CodeArts Doer (huaweicloud-maas)
 *
 * 端点：https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
 *
 * 码道对客户端是 OpenAI 兼容的（官方 CLI 用 @ai-sdk/openai-compatible），
 * 但鉴权不是 Bearer，而是华为云 IAM 的 SDK-HMAC-SHA256 签名：
 *
 *   Authorization: SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=..., Signature=...
 *
 * 签名每个请求都要重算（X-Sdk-Date 参与签名），所以放在 buildHeaders 里做，
 * 不能靠 registry 的静态 headers。
 *
 * AK/SK 存在 connection 的 providerSpecificData 里：
 *   { accessKeyId, secretAccessKey, securityToken? }
 * 走 apikey 连接模式，apiKey 字段本身不用填（UI 上仍需一个非空值）。
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

    // 官方 CLI 固定带的客户端标识（缺了网关会拒）
    headers["app-id"] = "CodeAgent3.0";
    headers["is-need-queue"] = "true";
    headers["x-ot-client-type"] = "CLI";
    headers["x-ot-client-version"] = "26.10.13";
    headers["x-codearts-doer-scenario-type"] = "web";
    headers["Accept"] = "text/event-stream";

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    // 码道是 SSE 流式端点，非流式请求会被拒（同 codebuddy-cn 的处理）
    transformed.stream = true;
    return transformed;
  }

  /**
   * 连通性探测：发一个最小流式请求，看签名能否被网关接受。
   *
   * 不能用通用的 Bearer 探测 —— 码道网关只认 IAM 签名，Bearer 会得到 401，
   * 而签名错误会得到 "verify ak sk signature fail"，两者需要区分开：
   * 前者说明凭据对了但签名实现有问题，后者说明 AK/SK 本身不对。
   *
   * 参数形态对齐 probeBedrockCredentials(connection, fetchImpl)：连接对象里带
   * providerSpecificData，fetchImpl 让调用方注入代理。
   */
  async probeCredentials(connection = {}, fetchImpl = fetch) {
    const { accessKeyId, secretAccessKey, securityToken } = this.getCredentials(connection);
    if (!accessKeyId || !secretAccessKey) {
      return { valid: false, error: "accessKeyId and secretAccessKey are required" };
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
    }
  }
}

export default CodeArtsExecutor;
