import { describe, it, expect } from "vitest";
import { CodeArtsExecutor } from "../../open-sse/executors/codearts-cn.js";

const AK = "AKIDEXAMPLE";
const SK = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

function credentials() {
  return {
    provider: "codearts-cn",
    providerSpecificData: { accessKeyId: AK, secretAccessKey: SK },
    connectionId: "conn-1",
  };
}

describe("CodeArts upstream session id", () => {
  it("derives a stable ses_<hex> id from the provider session id", () => {
    const ex = new CodeArtsExecutor();
    const a = ex.resolveUpstreamSessionId("conv-abc");
    const b = ex.resolveUpstreamSessionId("conv-abc");
    const c = ex.resolveUpstreamSessionId("conv-def");

    expect(a).toBe(b);              // 同一对话 → 同一个上游会话
    expect(a).not.toBe(c);          // 不同对话 → 不同上游会话
    expect(a).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  it("keeps the session id stable across buildHeaders calls", () => {
    const ex = new CodeArtsExecutor();
    const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
    const first = ex.buildHeaders(credentials(), true, url, "m", {}, "conv-xyz");
    const second = ex.buildHeaders(credentials(), true, url, "m", {}, "conv-xyz");

    expect(first["x-ot-session-id"]).toBe(second["x-ot-session-id"]);
    expect(first["user-session-id"]).toBe(first["x-ot-session-id"]);
  });

  it("does not mint a new upstream session for every request of one conversation", () => {
    // 码道的「并发会话数已达上限(3个)」限的是账号下**活跃的不同
    // x-ot-session-id 的个数**，不是同时在飞的请求数。实测固定一个
    // session id 连发 6 次全部成功，每次换新的则第 4 个开始被拒。
    //
    // 所以 buildHeaders 必须对同一 providerSessionId 给出同一个值，
    // 否则用户只开了一个会话也会在聊了几轮后撞上并发上限。
    const ex = new CodeArtsExecutor();
    const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
    const ids = new Set();
    for (let i = 0; i < 6; i++) {
      const headers = ex.buildHeaders(credentials(), true, url, "m", {}, "same-conversation");
      ids.add(headers["x-ot-session-id"]);
    }
    expect(ids.size).toBe(1);
  });

  it("falls back to a stable random id when no provider session id is given", () => {
    const ex = new CodeArtsExecutor();
    const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
    const first = ex.buildHeaders(credentials(), true, url, "m", {});
    const second = ex.buildHeaders(credentials(), true, url, "m", {});
    // 没有会话标识时也不能每个请求都换一个 —— 同样会撞并发上限
    expect(first["x-ot-session-id"]).toBe(second["x-ot-session-id"]);
    expect(first["x-ot-session-id"]).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  it("gives different conversations different upstream sessions", () => {
    const ex = new CodeArtsExecutor();
    const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions";
    const a = ex.buildHeaders(credentials(), true, url, "m", {}, "conv-1")["x-ot-session-id"];
    const b = ex.buildHeaders(credentials(), true, url, "m", {}, "conv-2")["x-ot-session-id"];
    expect(a).not.toBe(b);
  });
});
