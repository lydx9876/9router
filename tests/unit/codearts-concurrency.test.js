import { describe, expect, it, beforeEach } from "vitest";

import {
  acquireCodeArtsSlot,
  resetCodeArtsConcurrencyGates,
} from "../../open-sse/utils/codeartsConcurrency.js";

/**
 * 码道并发闸门的回归测试。
 *
 * 码道网关每个账号只允许 3 个**活跃会话**，超出返回 400 TM.00001041。
 *
 * ⚠️ 关键语义：「会话」是**不同的 x-ot-session-id**，不是同时在飞的请求。
 * 实测（真实 AK/SK）：
 *   - 固定一个 session id 连发 6 次 → 全部 200
 *   - 每次换新 session id         → 第 4 个开始被拒
 *
 * 所以闸门按 session id 分组：同一 id 共享名额（可以并发），
 * 不同 id 各占一个名额，最多 3 个。
 */
describe("codearts concurrency gate", () => {
  beforeEach(() => {
    resetCodeArtsConcurrencyGates();
  });

  it("allows three distinct sessions and blocks a fourth", async () => {
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1", `session-${i}`));
    }

    // 第四个不同的会话应该排队而不是立即拿到名额
    let acquired = false;
    const pending = acquireCodeArtsSlot("AK1", "session-3", { maxWaitMs: 90_000 }).then((r) => {
      acquired = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);

    releases[0]();
    releases[1]();
    releases[2]();
    // 等过持有窗口 → 名额释放，第四个拿到
    const r = await pending;
    expect(acquired).toBe(true);
    r();
  }, 120_000);

  it("lets the same session run again without waiting", async () => {
    // 同一会话可以连续请求（哪怕并发）—— 上游只数不同的会话。
    // 这条是「用户只开一个会话却撞上并发上限」的回归防线。
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1", `session-${i}`));
    }

    // 名额已满，但同一个 session id 依然可以拿到
    const release = await acquireCodeArtsSlot("AK1", "session-0", { maxWaitMs: 200 });
    expect(release).toBeTypeOf("function");
    release();

    releases.forEach((r) => r());
  });

  it("does not block a serial conversation on itself", async () => {
    // 同一对话的串行请求不应互相排队
    for (let i = 0; i < 5; i++) {
      const release = await acquireCodeArtsSlot("AK1", "same-conversation", { maxWaitMs: 200 });
      release();
    }
  });

  it("keeps the session occupied for the hold window after the request ends", async () => {
    // 上游的活跃会话不会立刻消失 —— 结束请求后名额仍占着
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1", `session-${i}`));
    }
    releases[0]();

    // 第 4 个不同的会话仍然拿不到名额
    let acquired = false;
    acquireCodeArtsSlot("AK1", "session-3", { maxWaitMs: 150 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);

    releases[1]();
    releases[2]();
  });

  it("frees the slot once the hold window elapses", async () => {
    const release = await acquireCodeArtsSlot("AK1", "session-a");
    release();

    // 名额被持有一段时间（上游会话自动回收前不能立刻给新会话用）
    let acquired = false;
    acquireCodeArtsSlot("AK1", "session-b", { maxWaitMs: 150 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);
  });

  it("gives each account its own quota", async () => {
    const r1 = await acquireCodeArtsSlot("AK1", "s1");
    const r2 = await acquireCodeArtsSlot("AK2", "s1");
    expect(r1).toBeTypeOf("function");
    expect(r2).toBeTypeOf("function");
    r1();
    r2();
  });

  it("aborts while waiting", async () => {
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1", `session-${i}`));
    }

    const controller = new AbortController();
    const pending = acquireCodeArtsSlot("AK1", "session-9", {
      signal: controller.signal,
      maxWaitMs: 90_000,
    });
    setTimeout(() => controller.abort(new Error("aborted")), 30);

    await expect(pending).rejects.toThrow(/aborted/);
    releases.forEach((r) => r());
  });

  it("times out instead of waiting forever", async () => {
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1", `session-${i}`));
    }

    await expect(
      acquireCodeArtsSlot("AK1", "session-x", { maxWaitMs: 120 }),
    ).rejects.toThrow(/still waiting/);
    releases.forEach((r) => r());
  });
});
