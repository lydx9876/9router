import { describe, expect, it } from "vitest";

import { getExecutor } from "../../open-sse/executors/index.js";

/**
 * 码道并发闸门的真实验证（live）。
 *
 * ⚠️ 目前 chat 请求是禁用的（上游要求 body 经 SM4-GCM 加密，未实现），
 * 所以这个测试默认跳过。加密层落地后，把 CODEARTS_ENABLE_ENCRYPTED_BODY=1
 * 传上即可真正跑起来。
 *
 * 码道对每个账号只允许 3 个并发会话，超出直接 400 TM.00001041
 * 「并发会话数已达上限(3个)，请关闭部分会话后重试」。这个测试直接发 6 个
 * 并发请求，验证闸门把它们排队而不是让 3 个撞上上游上限。
 *
 * 需要凭据：CODEARTS_AK / CODEARTS_SK。未设置时跳过。
 */
const AK = process.env.CODEARTS_AK;
const SK = process.env.CODEARTS_SK;
const ENCRYPTED = process.env.CODEARTS_ENABLE_ENCRYPTED_BODY === "1";

describe("codearts-cn live concurrency", () => {
  it.skipIf(!(AK && SK && ENCRYPTED))(
    "queues 6 concurrent requests without hitting the upstream limit",
    async () => {
      const ex = getExecutor("codearts-cn");
      const credentials = {
        provider: "codearts-cn",
        providerSpecificData: { accessKeyId: AK, secretAccessKey: SK },
      };
      const model = "deepseek-v4.1-flash-1017";

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, async (_, i) => {
          const r = await ex.execute({
            model,
            body: {
              model,
              messages: [{ role: "user", content: `说${i}` }],
              stream: true,
            },
            stream: true,
            credentials,
            log: null,
            proxyOptions: null,
          });
          const text = await r.response.text();
          const err = text.match(/"error_msg":"([^"]+)"/);
          if (err) throw new Error(err[1]);
          expect(r.response.status).toBe(200);
          return text.length;
        }),
      );

      const failures = results
        .map((r) => (r.status === "rejected" ? r.reason.message : null))
        .filter(Boolean);
      expect(failures).toEqual([]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    },
    180_000,
  );
});
