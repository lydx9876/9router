import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * TRAE CN executor — the pieces that are easy to get silently wrong.
 *
 * These all encode a failure that was reproduced against the live upstream, so a
 * regression here means a real user sees a broken provider:
 *
 *  - random device identity → `4011 exceeded the rate limit` that never clears
 *  - string message content → `cannot unmarshal ... LLMRawMessage`
 *  - object tool parameters → `cannot unmarshal object into ... parameters of type string`
 *  - tool_call fragments overwritten instead of merged → tool calls lose their id
 *  - a first-frame error treated as an empty successful answer
 */

const { default: TraeCnExecutor } = await import("../../open-sse/executors/trae-cn.js");
const { deriveTraeCnIdentity, seededDigits, seededUuid } = await import("../../open-sse/utils/traeCnIdentity.js");
const { traeCnUidFromToken, traeCnTokenExpiry, buildTraeCnTool } = await import("../../open-sse/executors/trae-cn.js");

function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

const UID = "1282504328491419";

describe("TRAE CN identity derivation", () => {
  it("reproduces the identity verified against the live upstream", () => {
    // The one value confirmed live: this uid's x-device-id must be exactly this,
    // or the upstream answers 4011.
    const id = deriveTraeCnIdentity(UID);
    expect(id.deviceId).toBe("500966969391093");
    expect(id.marketUserId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.machineId).toHaveLength(64);
    expect(id.traceId).toMatch(/^00-[0-9a-f]{16}-01$/);
    expect(id.sessionId).toHaveLength(16);
  });

  it("is deterministic — the same account always presents the same machine", () => {
    expect(deriveTraeCnIdentity(UID)).toEqual(deriveTraeCnIdentity(UID));
  });

  it("gives different accounts different identities", () => {
    const a = deriveTraeCnIdentity(UID);
    const b = deriveTraeCnIdentity("9999999999999999");
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(a.marketUserId).not.toBe(b.marketUserId);
  });

  it("refuses to derive without a uid", () => {
    expect(() => deriveTraeCnIdentity("")).toThrow(/uid/);
  });

  it("derives digits as byte % 10 and uuids with v4 bits forced", () => {
    expect(seededDigits(15, UID, "devid")).toMatch(/^\d{15}$/);
    expect(seededUuid(UID, "market")[14]).toBe("4");
  });
});

describe("TRAE CN credential parsing", () => {
  it("reads uid from the JWT payload instead of calling userinfo", () => {
    // GetUserInfo answers 20310 for these tokens, so the uid has to come from here.
    expect(traeCnUidFromToken(makeJwt({ data: { id: UID } }))).toBe(UID);
  });

  it("accepts the header value form, with the Cloud-IDE-JWT prefix", () => {
    // Users copy the whole header value out of the IDE; rejecting that would fail a
    // perfectly valid token.
    expect(traeCnUidFromToken(`Cloud-IDE-JWT ${makeJwt({ data: { id: UID } })}`)).toBe(UID);
  });

  it("survives whitespace pasted into the middle of the token", () => {
    // A wrapped line from a terminal or clipboard puts a newline mid-token. Left in
    // place it decodes to garbage and reports an opaque JSON parse error.
    const jwt = makeJwt({ data: { id: UID } });
    const broken = `${jwt.slice(0, 40)}\n  ${jwt.slice(40, 80)}\r\n${jwt.slice(80)}`;
    expect(traeCnUidFromToken(broken)).toBe(UID);
  });

  it("explains a malformed credential instead of crashing later", () => {
    expect(() => traeCnUidFromToken("not-a-jwt")).toThrow(/not a Cloud-IDE-JWT/);
    expect(() => traeCnUidFromToken("")).toThrow(/empty/);
    expect(() => traeCnUidFromToken(makeJwt({ data: {} }))).toThrow(/data\.id/);
  });

  it("reads expiry from exp", () => {
    expect(traeCnTokenExpiry(makeJwt({ data: { id: UID }, exp: 1999999999 }))).toBe(1999999999 * 1000);
    expect(traeCnTokenExpiry("garbage")).toBeNull();
  });
});

describe("TRAE CN request building", () => {
  const ex = new TraeCnExecutor();

  it("sends message content as typed blocks, never a bare string", () => {
    const body = ex.buildBody("glm-5.3", {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });
    expect(body.messages[0].content).toEqual([{ type: "text", text: "be brief" }]);
    expect(body.messages[1].content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("serialises tool parameters to a JSON string", () => {
    const tool = buildTraeCnTool({
      type: "function",
      function: { name: "get_weather", description: "d", parameters: { type: "object", properties: { city: { type: "string" } } } },
    });
    expect(typeof tool.function.parameters).toBe("string");
    expect(JSON.parse(tool.function.parameters)).toEqual({ type: "object", properties: { city: { type: "string" } } });
  });

  it("keeps an already-stringified parameters field untouched", () => {
    const tool = buildTraeCnTool({ function: { name: "f", parameters: '{"type":"object"}' } });
    expect(tool.function.parameters).toBe('{"type":"object"}');
  });

  it("always asks upstream to stream", () => {
    expect(ex.buildBody("glm-5.3", { messages: [], stream: false }).stream).toBe(true);
  });

  it("carries tool_call_id and prior tool_calls through a multi-turn exchange", () => {
    const body = ex.buildBody("glm-5.3", {
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"a":1}' } }] },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ],
    });
    expect(body.messages[0].tool_calls[0]).toMatchObject({
      id: "c1",
      function: { name: "f", arguments: '{"a":1}' },
    });
    expect(body.messages[1].tool_call_id).toBe("c1");
  });

  it("builds every header the upstream requires", () => {
    const headers = ex.buildHeaders({ apiKey: makeJwt({ data: { id: UID } }) });
    for (const key of [
      "authorization", "x-cloudide-token", "x-ide-token", "x-uid", "x-app-id",
      "x-ide-version", "x-ide-version-code", "x-ide-version-type", "x-device-type",
      "x-os-version", "x-device-brand", "x-machine-id", "x-device-id", "request-traffic-type",
      // Load-bearing, not cosmetic: without it the upstream answers 4011 for every
      // request. Confirmed by a single-variable comparison with every other header
      // held constant.
      "user-agent",
    ]) {
      expect(headers[key], `missing header ${key}`).toBeTruthy();
    }
    expect(headers.authorization).toMatch(/^Cloud-IDE-JWT /);
    expect(headers["x-device-id"]).toBe("500966969391093");
    expect(headers["x-machine-id"]).toHaveLength(64);
  });

  it("sends the IDE user agent that the upstream demands", () => {
    const headers = ex.buildHeaders({ apiKey: makeJwt({ data: { id: UID } }) });
    expect(headers["user-agent"]).toBe("VSCode 1.107.1 (TRAE SOLO CN)");
  });
});

describe("TRAE CN tool_call fragment assembly", () => {
  it("merges fragments per index and keeps the first id/name", () => {
    const acc = TraeCnExecutor.accumulator();
    acc.push([{ index: 0, id: "call_1", type: "function", function_call: { name: "get_weather", arguments: '{"' } }]);
    acc.push([{ index: 0, id: "", type: "function", function_call: { name: "", arguments: 'city":"Beijing"}' } }]);

    const list = acc.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("call_1");
    expect(list[0].function.name).toBe("get_weather");
    expect(list[0].function.arguments).toBe('{"city":"Beijing"}');
  });

  it("keeps parallel tool calls apart by index", () => {
    const acc = TraeCnExecutor.accumulator();
    acc.push([{ index: 0, id: "a", function_call: { name: "f", arguments: "{" } }]);
    acc.push([{ index: 1, id: "b", function_call: { name: "g", arguments: "{" } }]);
    acc.push([{ index: 0, function_call: { arguments: "}" } }]);
    acc.push([{ index: 1, function_call: { arguments: "}" } }]);
    const list = acc.list();
    expect(list.map((t) => [t.id, t.function.name, t.function.arguments])).toEqual([
      ["a", "f", "{}"],
      ["b", "g", "{}"],
    ]);
  });
});

describe("TRAE CN frame decoding", () => {
  it("unwraps the double-encoded envelope", () => {
    const frame = JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify({ response: "hi", reasoning_content: "think" }),
      statusCodeValue: 200,
      statusCode: "OK",
    });
    const { data, status } = TraeCnExecutor.decodeFrame("output", frame);
    expect(data).toEqual({ response: "hi", reasoning_content: "think" });
    expect(status).toBe(200);
  });

  it("passes a bare payload straight through", () => {
    // This is the shape the live CN endpoint returns. Failing to handle it is not a
    // loud error: every output frame decodes to something without a `response`
    // field, so the stream ends with empty content and reports success.
    const frame = JSON.stringify({ response: "Hi", reasoning_content: null, tool_calls: null, phase: null });
    const { data } = TraeCnExecutor.decodeFrame("output", frame);
    expect(data.response).toBe("Hi");
  });

  it("understands an unwrapped error frame", () => {
    const { data } = TraeCnExecutor.decodeFrame("error", JSON.stringify({ code: 4011, message: "rate limit" }));
    expect(data).toEqual({ code: 4011, message: "rate limit" });
  });

  it("does not treat an empty body or junk as a payload", () => {
    expect(TraeCnExecutor.decodeFrame("output", "not json").data).toBeNull();
    expect(TraeCnExecutor.decodeFrame("output", "null").data).toBeNull();
  });
});
