/**
 * 码道（CodeArts Doer）并发闸门
 *
 * 码道网关对每个账号限制**最多 3 个并发会话**，超出的请求直接返回
 *   400 {"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)，请关闭部分会话后重试。"}
 *
 * 实测特征（2026-11-04，cn-north-4）：
 *  - 限制是**账号级**的，与 AK/SK、连接数、模型都无关；
 *  - 槽位会**定时自动释放**（无需手动关会话），但请求结束后不会立即释放；
 *  - 固定 x-ot-session-id 不能复用槽位 —— 每次调用都占一个新槽位。
 *
 * 所以客户端并发发起 4 个请求时，第 4 个必然被拒。9router 作为网关必须
 * 自己排队，而不是把 400 透传给用户。
 *
 * 这里用「滑动窗口 + 信号量」实现：
 *  - inflight：当前正在发起的请求数（上限 MAX_CONCURRENT）
 *  - recent：最近刚结束的请求时间戳
 *
 * 之所以不只用 inflight：槽位在上游侧要留一阵子才释放，一个已经返回
 * 的请求仍然占着上游槽位。只按 inflight 计数会让第 4 个请求在第一个返回后
 * 立刻被放行，而上游还没释放槽位 → 又被拒。
 *
 * ⚠️ 测 TTL 时别用“每隔几秒探测一次”的办法 —— 探测请求本身也占槽位，会把
 * 窗口不断刷新，测出来的 TTL 假性偏长（一度测成 20–30s 甚至 60s）。
 * 正确做法：发请求 → 静默等待 → 一次性发满 3 个看是否全部成功。
 *
 * 限流按账号（AK）分组：同一账号的多个连接共享 3 个槽位，不同账号互不影响。
 */

/** 上游允许的并发会话数。 */
const MAX_CONCURRENT = 3;

/**
 * 槽位在上游侧的保留时长。
 *
 * 实测：静默足够长后槽位一定会自动回来（60 秒、2 分钟都验证过），
 * 但精确秒数很难测 —— 每次探测请求本身也占槽位，会刷新窗口。
 * 用“静默 N 秒后同时发 3 个，全成功即已释放”的方法测到：
 * 8s / 20s / 35s / 50s 都不够，60 秒以上才行。
 *
 * 所以这里不把窗口当权威 —— 它只用来“抹平突发”（一批请求同时来时，
 * 先让 3 个走，其余等窗口过去再走）。真正保证不失败的是 executor 里的
 * 退避重试：上游真的还在占位时，重试会一直等到它放出来。
 *
 * 取 15 秒：足以抹平突发的尾流，又不会让正常串行请求平白多等。
 */
const CONCURRENCY_WINDOW_MS = 15_000;

/** 单个请求最多等待多久才放弃（超过则透传上游错误，避免无限排队）。 */
const MAX_WAIT_MS = 180_000;

/** 按账号（AK）分组的闸门状态。 */
const gates = new Map();

/** 取（必要时创建）某账号的闸门状态。 */
function getGate(key) {
  let gate = gates.get(key);
  if (!gate) {
    gate = { inflight: 0, recent: [] };
    gates.set(key, gate);
  }
  return gate;
}

/**
 * 清理已滑出窗口的时间戳，并返回当前占用的槽位数。
 *
 * 占用数 = 仍在飞行中的请求 + 窗口内已发起过、但已结束的请求。
 *
 * recent 记录的是**已结束**请求的结束时间，inflight 记录**正在飞行**的请求，
 * 两者不重叠：一个请求要么在 inflight 里，要么在结束后进 recent。
 */
function occupiedSlots(gate) {
  const cutoff = Date.now() - CONCURRENCY_WINDOW_MS;
  // recent 是按时间升序追加的，从头部丢弃过期项
  while (gate.recent.length > 0 && gate.recent[0] < cutoff) {
    gate.recent.shift();
  }
  return gate.inflight + gate.recent.length;
}

/**
 * 占用一个槽位，必要时等待。
 *
 * @param {string} key   账号标识（AK）
 * @param {object} opts
 * @param {AbortSignal} [opts.signal] 客户端取消信号
 * @param {number} [opts.maxWaitMs]
 * @returns {Promise<() => void>} 释放函数（必须在请求结束后调用）
 */
export async function acquireCodeArtsSlot(key, { signal, maxWaitMs = MAX_WAIT_MS } = {}) {
  const gate = getGate(key);
  const deadline = Date.now() + maxWaitMs;

  // 自旋等待。用 setTimeout 而不是忙等 —— 上游槽位以秒为单位释放。
  while (occupiedSlots(gate) >= MAX_CONCURRENT) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `CodeArts concurrency limit: still waiting after ${Math.round(maxWaitMs / 1000)}s ` +
          `(max ${MAX_CONCURRENT} concurrent sessions per account).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.floor(Math.random() * 500)));
  }

  gate.inflight += 1;

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    gate.inflight = Math.max(0, gate.inflight - 1);
    // 刚结束的请求仍占着上游槽位 —— 记下结束时间，让它在窗口内继续计入占用
    gate.recent.push(Date.now());
  };
}

/** 测试辅助：清空所有闸门状态。 */
export function resetCodeArtsConcurrencyGates() {
  gates.clear();
}
