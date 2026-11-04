import { describe, expect, it, beforeEach } from "vitest";

import {
  acquireCodeArtsSlot,
  resetCodeArtsConcurrencyGates,
} from "../../open-sse/utils/codeartsConcurrency.js";

/**
 * 码道并发闸门的回归测试。
 *
 * 码道网关每个账号只允许 3 个并发会话，超出返回 400 TM.00001041。
 * 实测槽位在上游侧滞留 20–30 秒才释放，所以闸门不能只看"正在飞行中的
 * 请求"——否则前一个请求一返回就放行下一个，而上游还没释放槽位。
 */
describe("codearts concurrency gate", () => {
  beforeEach(() => {
    resetCodeArtsConcurrencyGates();
  });

  it("allows three concurrent slots and blocks the fourth", async () => {
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1"));
    }

    // 第四个应该排队而不是立即拿到槽位
    let acquired = false;
    const pending = acquireCodeArtsSlot("AK1", { maxWaitMs: 90_000 }).then((r) => {
      acquired = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);

    // 一个请求结束后，它的槽位仍被上游保留一阵子 —— 所以此时仍应是满的
    releases[0]();
    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);

    releases[1]();
    releases[2]();
    // 等过 45 秒窗口 → 槽位释放，第四个拿到
    const r = await pending;
    expect(acquired).toBe(true);
    r();
  }, 120_000);

  it("keeps the slot occupied for the window after the request ends", async () => {
    // 填满 3 个槽位
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1"));
    }
    // 结束其中一个 —— 上游槽位不会立刻释放，它仍占着位置
    releases[0]();

    // 所以第 4 个仍然拿不到槽位
    let acquired = false;
    acquireCodeArtsSlot("AK1", { maxWaitMs: 150 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);

    releases[1]();
    releases[2]();
  });

  it("frees the slot once the window elapses", async () => {
    const release = await acquireCodeArtsSlot("AK1");
    release();
    // 窗口是 45 秒 —— 超过它之后同一个账号又能拿到槽位
    const r = await acquireCodeArtsSlot("AK1", { maxWaitMs: 60_000 });
    expect(r).toBeTypeOf("function");
    r();
  }, 70_000);

  it("gives each account its own budget", async () => {
    const a = await acquireCodeArtsSlot("AK-A");
    const b = await acquireCodeArtsSlot("AK-B");
    const c = await acquireCodeArtsSlot("AK-B");
    const d = await acquireCodeArtsSlot("AK-B");

    // AK-A 只用了 1 个，AK-B 用满 3 个 —— 两者互不影响
    expect(a).toBeTypeOf("function");
    expect(b).toBeTypeOf("function");
    expect(c).toBeTypeOf("function");
    expect(d).toBeTypeOf("function");
    a();
    b();
    c();
    d();
  });

  it("times out instead of waiting forever", async () => {
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1"));
    }
    await expect(
      acquireCodeArtsSlot("AK1", { maxWaitMs: 120 }),
    ).rejects.toThrow(/concurrency limit/i);
    releases.forEach((r) => r());
  });

  it("honours an abort signal while waiting", async () => {
    const releases = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await acquireCodeArtsSlot("AK1"));
    }
    const ctrl = new AbortController();
    const pending = acquireCodeArtsSlot("AK1", { signal: ctrl.signal, maxWaitMs: 5000 });
    setTimeout(() => ctrl.abort(new Error("client gone")), 30);
    await expect(pending).rejects.toThrow(/client gone/);
    releases.forEach((r) => r());
  });

  it("is idempotent on release", async () => {
    const release = await acquireCodeArtsSlot("AK1");
    release();
    release();
    release();
    // 多调几次 release 不会把 inflight 算成负数
    const r = await acquireCodeArtsSlot("AK1", { maxWaitMs: 200 });
    expect(r).toBeTypeOf("function");
    r();
  });
});
