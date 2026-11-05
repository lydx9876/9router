/**
 * 码道（CodeArts Doer）并发闸门
 *
 * 码道网关对每个账号限制**最多 3 个活跃会话**，超出的请求直接返回
 *   400 {"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)，请关闭部分会话后重试。"}
 *
 * ## ⚠️ 「会话」指的是不同的 x-ot-session-id，不是同时在飞的请求
 *
 * 实测（2026-11-05，cn-north-4，真实 AK/SK）：
 *
 *   - 固定同一个 x-ot-session-id，连发 6 次 → 全部 200
 *   - 每次换一个新的 x-ot-session-id    → 第 4 个开始 400 TM.00001041
 *   - 3 个不同的 session id 各发 1 次     → 全部 200；第 4 个新的被拒
 *
 * 也就是说：限流数的是**账号下活跃的不同会话数**。同一个会话可以连续
 * 请求（哪怕并发），不同会话才有 3 个的名额。
 *
 * 这个区别很要紧 —— 按「在飞请求数」限流会做两件错事：
 *   1. 同一轮对话的串行请求互相排队，白白多等十几秒；
 *   2. 拦不住真正的问题 —— 每次请求都换新 session id 的话，
 *      「在飞数」可能只有 1，但上游那边已经攒了 3 个活跃会话。
 *
 * 所以这里按上游 session id 分组计数：
 *   - 同一 session id → 共享一个名额（可以并发）
 *   - 不同 session id → 各占一个名额，最多 3 个
 *
 * 名额的释放：上游的活跃会话会**定时自动回收**（实测请求结束后约 40 秒
 * 上下，具体值随上游负载浮动）。这里不做本地超时猜测 —— 猜短了会让请求
 * 被上游拒，猜长了会白等。真正兜底的是 executor 里的退避重试：上游真的
 * 还在占位时，重试会一直等到它放出来。
 *
 * ⚠️ 测 TTL 时别用「每隔几秒探测一次」的办法 —— 探测请求本身也占会话，
 * 会把窗口不断刷新，测出来的 TTL 假性偏长。正确做法：发请求 → 静默等待
 * → 一次性发满 3 个看是否全部成功。
 *
 * 限流按账号（AK）分组：同一账号的多个连接共享 3 个名额，不同账号互不影响。
 */

/** 上游允许的活跃会话数。 */
const MAX_SESSIONS = 3;

/**
 * 本地名额的保留时长（毫秒）。
 *
 * 只用来「抹平突发」—— 一批新会话同时来时，先让 3 个走，其余等名额回收。
 * 取值必须**明显小于**上游的真实回收时间，否则本地提前放行、上游仍占位，
 * 请求会被拒（重试能救，但多一轮延迟）。
 */
const SESSION_HOLD_MS = 45_000;

/** 单个请求最多等待多久才放弃（超过则透传上游错误，避免无限排队）。 */
const MAX_WAIT_MS = 180_000;

/** 按账号（AK）分组的闸门状态。 */
const gates = new Map();

/** 取（必要时创建）某账号的闸门状态。 */
function getGate(key) {
  let gate = gates.get(key);
  if (!gate) {
    // sessions: Map<上游 session id, 该会话最近一次占用/释放的时间>
    gate = { sessions: new Map() };
    gates.set(key, gate);
  }
  return gate;
}

/**
 * 清理已过期的会话条目，返回当前占用的会话数。
 *
 * 过期判定用的是「该会话最近一次活动的时间 + SESSION_HOLD_MS」——
 * 一个会话在窗口内再次被用到，就重新计时，这样活跃对话不会被误清。
 *
 * @param {object} gate
 * @returns {number}
 */
function occupiedSessions(gate) {
  const cutoff = Date.now() - SESSION_HOLD_MS;
  for (const [id, lastUsed] of gate.sessions) {
    if (lastUsed < cutoff) gate.sessions.delete(id);
  }
  return gate.sessions.size;
}

/**
 * 占用一个上游会话名额，必要时等待。
 *
 * @param {string} key        账号标识（AK）
 * @param {string} sessionId  上游会话 id（x-ot-session-id）—— 同一个 id 共享名额
 * @param {object} opts
 * @param {AbortSignal} [opts.signal] 客户端取消信号
 * @param {number} [opts.maxWaitMs]
 * @returns {Promise<() => void>} 释放函数（必须在请求结束后调用）
 */
export async function acquireCodeArtsSlot(key, sessionId, { signal, maxWaitMs = MAX_WAIT_MS } = {}) {
  const gate = getGate(key);
  const id = String(sessionId || key);
  const deadline = Date.now() + maxWaitMs;

  // 自旋等待。用 setTimeout 而不是忙等 —— 上游会话以秒为单位回收。
  while (true) {
    const occupied = occupiedSessions(gate);
    // 同一个会话 id 已经有位置就直接放行（哪怕名额已满 —— 上游允许同一会话并发）
    if (gate.sessions.has(id) || occupied < MAX_SESSIONS) {
      break;
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `CodeArts concurrency limit: still waiting after ${Math.round(maxWaitMs / 1000)}s ` +
          `(max ${MAX_SESSIONS} concurrent sessions per account).`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.floor(Math.random() * 500)));
  }

  gate.sessions.set(id, Date.now());

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    // 名额不立即释放 —— 上游的活跃会话还在，刷新一下活跃时间即可。
    gate.sessions.set(id, Date.now());
  };
}

/** 测试辅助：清空所有闸门状态。 */
export function resetCodeArtsConcurrencyGates() {
  gates.clear();
}
