export default {
  id: "codearts-cn",
  // 模型前缀（cdc/deepseek-v4.1-flash-1017）。"cdc" = CodeArts Doer CN。
  alias: "cdc",
  uiAlias: "cdc",
  priority: 90,
  display: {
    name: "CodeArts CN",
    icon: "smart_toy",
    color: "#C7000B",
    website: "https://codearts.huaweicloud.com",
    notice: {
      signupUrl: "https://codearts.huaweicloud.com/portal/settings/cli-auth",
    },
  },
  category: "apikey",
  // 华为云 IAM 的 AK/SK 走 apikey 连接模式，凭据存 providerSpecificData
  authModes: ["apikey"],
  // 用专门的凭据表单收 AK/SK（apiKey 字段本身不需要填真值）
  credentialForm: "codearts",
  // 没有 Bearer API Key —— 凭据就是 AK/SK，声明后创建连接不再强制 apiKey 非空
  apiKeyOptionalWith: "accessKeyId",
  authHint: "华为云 AK/SK（IAM 访问密钥），申请入口 https://codearts.huaweicloud.com/portal/settings/cli-auth",
  transport: {
    baseUrl: "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions",
    forceStream: true,
    // 码道是 OpenAI 风格网关，thinking 走 reasoning_effort。
    // 标准 openai 格式的档位（none/low/medium/high/xhigh）已被上游实测接受。
    thinkingFormat: "openai",
    headers: {
      "Content-Type": "application/json",
    },
    timeoutMs: 180000,
    stallTimeoutMs: 180000,
    // 配额接口：AK/SK 签名即可，不需要 Web 会话 Cookie
    usage: {
      url: "https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin",
    },
  },
  // thinking 用 reasoning_effort，实测 none | low | medium | high | xhigh | max 均被上游接受。
  // UI 档位由 capabilities 的 thinkingFormat 决定（标准 openai 集合，不含 max）。
  models: [
    // 模型列表取自官方 CodeArts Doer CLI 的 `codearts models` 实测输出
    // （provider = huaweicloud-maas），与 Web 端 /model/builtin 一致。
    // id 保持 CLI 的原始大小写：网关虽然大小写不敏感，但别名/统计按原样匹配。
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek-V4.1-Flash-1017" },
    { id: "GLM-5.2", name: "GLM-5.2" },
    { id: "glm-5.2-sft-harmony", name: "GLM-5.2-ArkTS-SPARK" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "kimi-k3", name: "Kimi-K3" },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro" },
    { id: "openpangu-2.0-flash", name: "OpenPangu-2.0-Flash" },
    { id: "openpangu-2.0-pro", name: "OpenPangu-2.0-Pro" },
    { id: "speed", name: "智速模式" },
  ],
  features: {
    // 配额跟踪：snap-manager 插件统计接口，AK/SK 签名即可调用
    usage: true,
    // 凭据是 AK/SK 对而非单个 Bearer key
    usageApikey: true,
  },
};
