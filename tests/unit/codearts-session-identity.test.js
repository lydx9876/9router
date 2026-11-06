// CodeArts Doer limits an account to 3 *live* upstream sessions and counts
// distinct session ids, not in-flight requests (verified against the live
// gateway: a fixed session id survives 6 sequential requests, a fresh one
// per request is rejected from the 4th on with 400 TM.00001041).
//
// The session id therefore has to survive a whole conversation, and separate
// conversations have to stay separate — otherwise a client that sends a fresh
// x-client-request-id per request (the default for most HTTP libraries) opens
// a new upstream session on every call and the next request waits 40–45s for
// the upstream to recycle a slot.
import { describe, it, expect, beforeEach } from "vitest";
import { resolveSessionId, resolveSessionIdentity } from "../../open-sse/utils/sessionManager.js";
import crypto from "node:crypto";

const SCOPE = "codearts-cn";

const freshRequestId = () => ({ "x-client-request-id": crypto.randomUUID() });

// A conversation that grows turn by turn. `firstReplyLength` controls whether
// the opening answer is shorter than the assistant-text hash threshold (50).
function conversation(terminal, turns, firstReplyLength = 80) {
  const firstReply = "答".repeat(firstReplyLength);
  const messages = [{ role: "user", content: `终端${terminal}的第一句问题` }];
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: "assistant", content: i === 1 ? firstReply : `补充${i}` });
    messages.push({ role: "user", content: `终端${terminal} 第${i + 1}轮` });
  }
  return { messages };
}

const resolve = (body, headers = freshRequestId(), connectionId = "conn-1", scope = SCOPE) =>
  resolveSessionId({ headers, body, connectionId, scope });

describe("codearts-cn session identity", () => {
  it("keeps one upstream session for a whole conversation", () => {
    const ids = [];
    for (let turns = 1; turns <= 6; turns++) {
      ids.push(resolve(conversation(1, turns)));
    }
    expect(new Set(ids).size).toBe(1);
  });

  it("keeps one session even when the opening reply is too short for the assistant-text hash", () => {
    // The assistant-text hash needs 50 characters; a short first reply used to
    // make the conversation fall back to the per-connection id on turn one and
    // switch to the hash on turn two — one conversation, two upstream sessions.
    for (const length of [10, 30, 49]) {
      const ids = [];
      for (let turns = 1; turns <= 6; turns++) {
        ids.push(resolve(conversation(1, turns, length)));
      }
      expect(new Set(ids).size).toBe(1);
    }
  });

  it("gives separate conversations separate sessions", () => {
    const ids = [1, 2, 3].map((t) => resolve(conversation(t, 3)));
    expect(new Set(ids).size).toBe(3);
  });

  it("fits three parallel conversations into the upstream limit of three", () => {
    // Three pi terminals on one CodeArts connection — the exact scenario that
    // used to exhaust the three upstream slots and start queueing.
    const all = new Set();
    for (const t of [1, 2, 3]) {
      for (let turns = 1; turns <= 5; turns++) {
        all.add(resolve(conversation(t, turns)));
      }
    }
    expect(all.size).toBeLessThanOrEqual(3);
  });

  it("ignores a one-shot x-client-request-id", () => {
    const body = conversation(1, 3);
    const a = resolve(body, { "x-client-request-id": "req-1" });
    const b = resolve(body, { "x-client-request-id": "req-2" });
    expect(a).toBe(b);
  });

  it("still honours an explicit session id from the client", () => {
    expect(resolve(conversation(1, 2), { "x-session-id": "my-conv" })).toBe("my-conv");
    expect(resolve({ ...conversation(1, 2), prompt_cache_key: "pk-1" }, {})).toBe("pk-1");
    expect(resolve({ ...conversation(1, 2), session_id: "sid-1" }, {})).toBe("sid-1");
  });

  it("leaves other providers on their existing behaviour", () => {
    // x-client-request-id still identifies a session everywhere else.
    const body = conversation(1, 2);
    for (const scope of ["openai", "claude", "codex", "antigravity"]) {
      const a = resolveSessionId({ headers: { "x-client-request-id": "req-1" }, body, connectionId: "c1", scope });
      const b = resolveSessionId({ headers: { "x-client-request-id": "req-2" }, body, connectionId: "c1", scope });
      expect(a).not.toBe(b);
    }
  });

  it("reports the resolved id as non-ephemeral", () => {
    const identity = resolveSessionIdentity({
      headers: freshRequestId(),
      body: conversation(1, 2),
      connectionId: "conn-1",
      scope: SCOPE,
    });
    expect(identity.ephemeral).toBe(false);
    expect(identity.sessionId).toBeTruthy();
  });
});