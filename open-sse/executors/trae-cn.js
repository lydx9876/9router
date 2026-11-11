import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDERS } from "../config/providers.js";
import { deriveTraeCnIdentity } from "../utils/traeCnIdentity.js";
import { resolveTraeCnChannel } from "../services/traeCnModels.js";

/**
 * TraeCnExecutor — talks to the Trae CN IDE surface (www.trae.cn).
 *
 * ## Why this is not `trae.js`
 *
 * `trae.js` speaks the intl SOLO surface: create a chat session, then poll an events
 * stream. This one speaks the CN IDE surface: a single POST that streams SSE back.
 * The two do not share tokens or endpoints — see the note in
 * `providers/registry/trae-cn.js`.
 *
 * ## Request shape (everything here was verified against a live account)
 *
 *   POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
 *   body { messages, function, stream, config_name, model, tools? }
 *
 * `messages[].content` must be an array of typed blocks, not a string — upstream
 * rejects a plain string with `cannot unmarshal string into ... LLMRawMessage`.
 * `tools[].function.parameters` must be a JSON *string*, not an object — see
 * buildTraeCnTool.
 *
 * ## SSE envelope
 *
 * Frames must be decoded in two possible shapes (see decodeFrame):
 *
 *  - bare — `{"response":"Hi","reasoning_content":null,...}`. This is what the live
 *    CN endpoint actually returns today.
 *  - wrapped — `{headers, body, statusCodeValue}` with the payload in `body` as a
 *    JSON string. Older captures and the public docs show this shape.
 *
 * Handling only the wrapped form does not error — it silently yields an empty but
 * "successful" answer, so both are supported.
 *
 * `output` frames carry `{response, reasoning_content, tool_calls}`; `token_usage`
 * carries the usage.
 *
 * ## Identity
 *
 * Every request must present the same derived device identity for a given account.
 * A random one is answered with `4011 "exceeded the rate limit"`, which looks like
 * throttling but never clears. See utils/traeCnIdentity.js.
 */

const TRAE_CN_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const TRAE_CN_IDE_VERSION = "0.1.52";
const TRAE_CN_IDE_VERSION_CODE = "20260811";
const TRAE_CN_DEVICE_TYPE = "macos";
const TRAE_CN_OS_VERSION = "macOS 15.7.4";
const TRAE_CN_DEVICE_BRAND = "Apple";
// The user agent is load-bearing, not cosmetic. Controlled comparison against a live
// account with every other header held constant: without it the upstream answers
// {"code":4011,"message":"...exceeded the rate limit"} — the same misleading error
// a wrong device identity produces, which sends people to hunt for a rate limit that
// does not exist. With it, the request streams normally.
const TRAE_CN_USER_AGENT = "VSCode 1.107.1 (TRAE SOLO CN)";
// Upstream always streams; ChatCore aggregates for non-stream clients (forceStream).
// The channel for a model comes from the live catalog (services/traeCnModels.js) —
// it is per-model, not a global default, so there is no fallback constant here.

/** Pull the uid out of a Cloud-IDE-JWT. Throws with a readable reason when absent. */
export function traeCnUidFromToken(token) {
  const raw = normalizeTraeCnToken(token);
  if (!raw) throw new Error("trae-cn: empty token");
  const parts = raw.split(".");
  if (parts.length < 2) {
    throw new Error("trae-cn: credential is not a Cloud-IDE-JWT (expected 3 dot-separated segments)");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("trae-cn: credential payload is not decodable JSON");
  }
  const uid = payload?.data?.id;
  if (!uid) {
    throw new Error("trae-cn: credential payload has no data.id (uid) — re-copy the token from the IDE");
  }
  return String(uid);
}

/**
 * Translate an upstream error into something a caller can act on.
 *
 * `4001` is the one that matters: the upstream words it as "bad request", which
 * reads like a malformed body and sends you off inspecting JSON. In practice it
 * means the model is not available on the channel the request used — a routing
 * problem, not a formatting one.
 */
export function explainTraeCnError(err, model) {
  const code = err?.code;
  const raw = err?.message || (err ? JSON.stringify(err) : "unknown error");
  if (code === 4001) {
    return `trae-cn: model "${model}" is not available on this channel (upstream 4001). The model is probably served by a different channel; refresh the model list so its channel is resolved.`;
  }
  if (code === 4011) {
    return `trae-cn: upstream answered 4011. This is either a device-identity mismatch or a missing IDE user agent — not necessarily rate limiting, despite the wording (${raw}).`;
  }
  if (code === 1001) {
    return `trae-cn: credential rejected (1001). It has probably expired — re-paste the Cloud-IDE-JWT.`;
  }
  return `trae-cn ${code ?? ""}: ${raw}`.trim();
}

/**
 * Strip an optional `Cloud-IDE-JWT ` scheme prefix and all whitespace.
 *
 * The IDE hands users the whole header value, and it is natural to paste it that
 * way, so accept both forms rather than rejecting a correct token. Whitespace is
 * removed rather than merely trimmed because a wrapped line from a terminal or a
 * clipboard inserts a newline mid-token, which otherwise surfaces as an opaque
 * JSON parse error on the payload.
 */
export function normalizeTraeCnToken(token) {
  return String(token || "")
    .replace(/\s+/g, "")
    .replace(/^Cloud-IDE-JWT/i, "");
}

/** Expiry (ms epoch) from a JWT, or null. */
export function traeCnTokenExpiry(token) {
  try {
    const parts = normalizeTraeCnToken(token).split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * OpenAI content (string or block array) → TRAE's typed block array.
 * Upstream rejects plain strings outright, so this run for every message.
 */
function toTraeContent(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) out.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    // Text blocks: OpenAI uses `text`, some clients use `content`.
    if (part.type === "text" || part.text != null) {
      const text = typeof part.text === "string" ? part.text : String(part.text?.value ?? part.content ?? "");
      if (text) out.push({ type: "text", text });
      continue;
    }
    // Anything else (images, files) is not supported by this surface — keep the
    // text we understand rather than sending a block shape upstream will reject.
    if (typeof part.content === "string" && part.content) {
      out.push({ type: "text", text: part.content });
    }
  }
  return out;
}

/**
 * OpenAI tool → TRAE tool.
 *
 * `parameters` must be a JSON string. Sending the object form is answered with
 * `cannot unmarshal object into Go struct field FunctionDefinition.tools.function.parameters
 * of type string` — a message that points at the type, not at the fix.
 */
export function buildTraeCnTool(tool) {
  const fn = tool?.function || tool;
  if (!fn?.name) return null;
  let params = fn.parameters;
  if (params != null && typeof params !== "string") {
    try {
      params = JSON.stringify(params);
    } catch {
      params = "{\"type\":\"object\",\"properties\":{}}";
    }
  }
  if (!params) params = "{\"type\":\"object\",\"properties\":{}}";
  const out = { type: "function", function: { name: String(fn.name), parameters: params } };
  if (fn.description) out.function.description = String(fn.description);
  return out;
}

/** OpenAI messages → TRAE messages. */
export function buildTraeCnMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "developer" ? "system" : m.role;
    if (!role) continue;
    const entry = { role, content: toTraeContent(m.content) };
    // Tool results must keep their correlation id or the model cannot tell which
    // call it is answering.
    if (role === "tool") {
      if (m.tool_call_id) entry.tool_call_id = String(m.tool_call_id);
      if (m.name) entry.name = String(m.name);
    }
    // Assistant turns that called tools: pass the calls back so the model sees
    // what it already asked for.
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      entry.tool_calls = m.tool_calls.map((tc) => ({
        id: tc?.id || "",
        type: "function",
        function: {
          name: tc?.function?.name || "",
          // arguments are already a JSON string in the OpenAI shape
          arguments: typeof tc?.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc?.function?.arguments ?? {}),
        },
      }));
    }
    out.push(entry);
  }
  return out;
}

/**
 * TraeCnExecutor
 */
export default class TraeCnExecutor extends BaseExecutor {
  constructor() {
    super("trae-cn", PROVIDERS["trae-cn"]);
  }

  baseUrl() {
    return (this.config?.baseUrl || "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat").replace(/\/$/, "");
  }

  /** Credentials → { token, uid, identity }. Token may be on apiKey or accessToken. */
  resolveCredentials(credentials) {
    const token = normalizeTraeCnToken(credentials?.accessToken || credentials?.apiKey || "");
    const uid = credentials?.providerSpecificData?.uid || traeCnUidFromToken(token);
    return { token, uid, identity: deriveTraeCnIdentity(uid) };
  }

  buildHeaders(credentials, stream = true) {
    const { token, uid, identity } = this.resolveCredentials(credentials);
    return {
      authorization: `Cloud-IDE-JWT ${token}`,
      "x-cloudide-token": token,
      "x-ide-token": token,
      "x-uid": uid,
      "x-app-id": TRAE_CN_APP_ID,
      "x-ide-version": TRAE_CN_IDE_VERSION,
      "x-ide-version-code": TRAE_CN_IDE_VERSION_CODE,
      "x-app-version-code": TRAE_CN_IDE_VERSION_CODE,
      "x-ide-version-type": "stable",
      "x-device-type": TRAE_CN_DEVICE_TYPE,
      "x-os-version": TRAE_CN_OS_VERSION,
      "x-device-brand": TRAE_CN_DEVICE_BRAND,
      "x-machine-id": identity.machineId,
      "x-device-id": identity.deviceId,
      "request-traffic-type": "prod",
      "content-type": "application/json",
      "user-agent": TRAE_CN_USER_AGENT,
      accept: stream === false ? "application/json" : "text/event-stream",
    };
  }

  /** Build the upstream request body from the OpenAI-shaped body ChatCore hands us. */
  buildBody(model, body) {
    const messages = buildTraeCnMessages(body?.messages);
    // The channel is not a free choice: a model is only callable on the channel
    // that lists it, and the wrong one answers `4001 bad request`, which reads
    // like a body-format error. resolveTraeCnChannel consults the live catalog;
    // callers that already have a channel (from a resolved catalog) pass it in.
    const channel = body?.function || resolveTraeCnChannel(model);
    const payload = {
      messages,
      function: channel,
      // Upstream is stream-only.
      stream: true,
      config_name: model,
      model,
    };
    const tools = Array.isArray(body?.tools) ? body.tools.map(buildTraeCnTool).filter(Boolean) : [];
    if (tools.length > 0) payload.tools = tools;
    if (body?.tool_choice) {
      // Upstream takes a string enum; OpenAI also allows an object form (including
      // a forced single function). Anything non-string maps to "auto" — forcing a
      // specific tool is expressed through the tool list upstream, not this field.
      payload.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : "auto";
    }
    if (typeof body?.temperature === "number") payload.temperature = body.temperature;
    return payload;
  }

  /**
   * One tool_call accumulator per index.
   *
   * TRAE streams `tool_calls` as fragments: the first frame carries id + name, later
   * frames carry only an `arguments` chunk and empty id/name. Overwriting on every
   * frame would erase the id and name, so each field only fills a blank.
   */
  static accumulator() {
    const byIndex = new Map();
    return {
      push(toolCalls) {
        if (!Array.isArray(toolCalls)) return;
        for (const tc of toolCalls) {
          const index = Number.isInteger(tc?.index) ? tc.index : 0;
          const slot = byIndex.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
          const fn = tc?.function_call || tc?.function || {};
          if (tc?.id) slot.id = tc.id;
          if (fn?.name) slot.function.name = fn.name;
          if (typeof fn?.arguments === "string") slot.function.arguments += fn.arguments;
          byIndex.set(index, slot);
        }
      },
      isEmpty() {
        return byIndex.size === 0;
      },
      list() {
        return [...byIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v);
      },
    };
  }

  /**
   * Decode one SSE data frame.
   *
   * Live CN captures show two shapes and both have to work:
   *
   *   1. bare payload — `{"response":"Hi","reasoning_content":null,...}`
   *      This is what `llm_utils_chat` actually returns today.
   *   2. wrapped envelope — `{headers, body, statusCodeValue, statusCode}` where
   *      `body` is a JSON string. Older captures and the public docs show this.
   *
   * Treating only the wrapped shape as valid silently drops every token: output
   * frames parse to an object with no `response` field, so the stream completes
   * with empty content and no error — the worst possible failure mode.
   */
  static decodeFrame(eventName, rawData) {
    let outer;
    try {
      outer = JSON.parse(rawData);
    } catch {
      return { event: eventName, data: null };
    }
    if (!outer || typeof outer !== "object") return { event: eventName, data: null };

    // Wrapped envelope.
    if ("body" in outer) {
      const status = outer.statusCodeValue;
      let inner = outer.body;
      if (typeof inner === "string") {
        try {
          inner = JSON.parse(inner);
        } catch {
          inner = { _raw: inner };
        }
      }
      return { event: eventName, data: inner, status };
    }

    // Bare payload (including unwrapped error frames: {code, message}).
    return { event: eventName, data: outer };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const streamRequested = stream !== false;
    const responseId = `chatcmpl-trae-cn-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    let headers;
    let payload;
    try {
      headers = this.buildHeaders(credentials, streamRequested);
      payload = this.buildBody(model, body);
    } catch (err) {
      log?.error?.("TRAE-CN", `request build failed: ${err.message}`);
      return this.errorResult(401, err.message, model);
    }

    const url = this.baseUrl();
    let upstream;
    try {
      upstream = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      }, proxyOptions);
    } catch (err) {
      return this.errorResult(502, `trae-cn request failed: ${err?.message || err}`, model);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      log?.warn?.("TRAE-CN", `HTTP ${upstream.status}: ${String(text).slice(0, 200)}`);
      return this.errorResult(upstream.status || 502, text || `trae-cn HTTP ${upstream.status}`, model);
    }

    // Upstream answered with a JSON error instead of a stream (auth/param errors).
    const contentType = upstream.headers?.get?.("content-type") || "";
    if (contentType.includes("application/json")) {
      const text = await upstream.text().catch(() => "");
      return this.errorResult(502, text || "trae-cn returned JSON instead of an SSE stream", model);
    }
    if (!upstream.body) {
      return this.errorResult(502, "trae-cn returned no response body", model);
    }

    const encoder = new TextEncoder();
    const tools = TraeCnExecutor.accumulator();
    // Reasoning is cumulative in some frames and delta-like in others; track what
    // was already emitted so neither style duplicates text.
    let reasoningSent = "";
    let contentSent = "";

    const sse = new ReadableStream({
      start: async (controller) => {
        const emit = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const chunk = (delta, finishReason = null) => emit({
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });

        chunk({ role: "assistant" });

        let upstreamError = null;
        let finishReason = "stop";
        let usage = null;

        const handleFrame = (eventName, rawData) => {
          const { event, data } = TraeCnExecutor.decodeFrame(eventName, rawData);
          if (!data) return false;

          // An `error` event is authoritative. Also catch an error payload that
          // arrives under some other event name, but only when it actually looks
          // like an error: `output` frames legitimately carry `code: 0`, and a
          // bare `code` on its own is not a failure.
          const looksLikeError = data.code != null && data.code !== 0 && !("response" in data);
          if (event === "error" || looksLikeError) {
            upstreamError = data;
            return true;
          }
          if (event === "token_usage") {
            usage = data;
            return false;
          }
          if (event === "output") {
            const piece = data.response;
            if (typeof piece === "string" && piece) {
              contentSent += piece;
              chunk({ content: piece });
            }
            const think = data.reasoning_content;
            if (typeof think === "string" && think) {
              // Some frames are cumulative — only emit the new tail.
              const delta = think.startsWith(reasoningSent)
                ? think.slice(reasoningSent.length)
                : think;
              reasoningSent = think.startsWith(reasoningSent) ? think : reasoningSent + think;
              if (delta) chunk({ reasoning_content: delta });
            }
            if (Array.isArray(data.tool_calls)) tools.push(data.tool_calls);
            return false;
          }
          if (event === "done") {
            if (data.finish_reason) finishReason = data.finish_reason;
            return true;
          }
          return false;
        };

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = null;
        let finished = false;

        try {
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, nl).replace(/\r$/, "");
              buffer = buffer.slice(nl + 1);
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                const rawData = line.slice(5).trim();
                if (rawData && handleFrame(eventName, rawData)) {
                  finished = true;
                  break;
                }
              } else if (line === "") {
                eventName = null;
              }
            }
          }
          if (!finished && buffer.trim()) {
            // Trailing frame without a newline.
            const line = buffer.trim();
            if (line.startsWith("data:")) handleFrame(eventName, line.slice(5).trim());
          }
          await reader.cancel().catch(() => {});
        } catch (err) {
          controller.error(err);
          return;
        }

        if (upstreamError) {
          // Turn the upstream rejection into an error the client can see, instead
          // of closing an empty stream that looks like a successful empty answer.
          emit({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            error: {
              message: explainTraeCnError(upstreamError, model),
              type: "api_error",
            },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        const toolList = tools.list();
        if (toolList.length > 0) {
          chunk({ tool_calls: toolList.map((tc, i) => ({ index: i, ...tc })) }, "tool_calls");
        } else {
          chunk({}, finishReason);
        }

        if (usage) {
          emit({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: usage.prompt_tokens || 0,
              completion_tokens: usage.completion_tokens || 0,
              total_tokens: usage.total_tokens || 0,
              ...(usage.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } } : {}),
            },
          });
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return {
      response: new Response(sse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url,
      headers,
      transformedBody: payload,
    };
  }

  errorResult(status, message, model) {
    return {
      response: new Response(
        JSON.stringify({ error: { message: String(message || "trae-cn error"), type: "api_error", code: "" } }),
        { status, headers: { "Content-Type": "application/json" } },
      ),
      url: this.baseUrl(),
      headers: {},
      transformedBody: { model },
    };
  }

  /** Renewal is handled by services/tokenRefresh/providers.js::refreshTraeToken. */
  async refreshCredentials() {
    return null;
  }
}
