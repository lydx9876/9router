/**
 * Session Manager for Antigravity Cloud Code
 *
 * Handles session ID generation and caching for prompt caching continuity.
 * Mimics the Antigravity binary behavior: generates a session ID at startup
 * and keeps it for the process lifetime, scoped per account/connection.
 *
 * Reference: antigravity-claude-proxy/src/cloudcode/session-manager.js
 */

import crypto from "crypto";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";

// Runtime storage: Key = connectionId, Value = { sessionId, lastUsed }
const runtimeSessionStore = new Map();
const continuationStore = new Map();

// Periodically evict entries that haven't been used within TTL
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of runtimeSessionStore) {
        if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
            runtimeSessionStore.delete(key);
        }
    }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);

// Allow Node.js to exit even if interval is still active
if (cleanupInterval.unref) cleanupInterval.unref();

/**
 * Get or create a session ID for the given connection.
 *
 * The binary generates a session ID once at startup: `rs() + Date.now()`.
 * Since 9router is long-running, we simulate this "per-launch" behavior by
 * storing a generated ID in memory for each connection.
 *
 * - If 9router restarts, the ID changes (matching binary restart behavior).
 * - Within a running instance, the ID is stable for that connection.
 * - This enables prompt caching while using the EXACT random logic of the binary.
 *
 * @param {string} connectionId - The connection identifier (email or unique ID)
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(connectionId) {
    if (!connectionId) {
        return generateBinaryStyleId();
    }

    const existing = runtimeSessionStore.get(connectionId);
    if (existing) {
        existing.lastUsed = Date.now();
        return existing.sessionId;
    }

    // Evict oldest entry if store exceeds max size (safety cap between cleanup cycles)
    const MAX_SESSIONS = 1000;
    if (runtimeSessionStore.size >= MAX_SESSIONS) {
      const oldest = runtimeSessionStore.keys().next().value;
      runtimeSessionStore.delete(oldest);
    }

    const sessionId = generateBinaryStyleId();
    runtimeSessionStore.set(connectionId, { sessionId, lastUsed: Date.now() });
    return sessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * Format: `rs() + Date.now()` where `rs()` is randomUUID
 *
 * @returns {string} A session ID in binary format
 */
export function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs (e.g. useful for testing or explicit reset)
 */
export function clearSessionStore() {
    runtimeSessionStore.clear();
    assistantSessionStore.clear();
    continuationStore.clear();
}

// Conversation-stable session store: Key = hash(scope+assistant text), Value = { sessionId, lastUsed }
const assistantSessionStore = new Map();
// Same idea, but keyed on the conversation's first user message — stable from
// the very first turn, unlike the assistant-text hash.
const firstUserSessionStore = new Map();
const ASSISTANT_MIN_LEN = 50;
const ASSISTANT_CAP_LEN = 50;
const MAX_ASSISTANT_SESSIONS = 5000;
const MAX_CONTINUATION_SESSIONS = 5000;

// Client headers/body fields that carry an upstream session id (priority order)
const SESSION_HEADER_KEYS = ["x-session-id", "session-id", "session_id", "x-amp-thread-id"];
const CLAUDE_CODE_SESSION_RE = /_session_([a-f0-9-]+)$/;
const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id";

function sha16(text) {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Normalize a session id candidate (trim, length cap)
function normalizeSessionId(value) {
    if (typeof value !== "string") return null;
    const v = value.trim();
    if (!v || v.length > 256) return null;
    return v;
}

// Extract Claude Code session id from metadata.user_id (_session_{uuid} | JSON {session_id})
function extractClaudeCodeSession(userId) {
    if (typeof userId !== "string" || !userId) return null;
    const m = userId.match(CLAUDE_CODE_SESSION_RE);
    if (m) return m[1];
    if (userId[0] === "{") {
        try { return normalizeSessionId(JSON.parse(userId)?.session_id); } catch { /* noop */ }
    }
    return null;
}

// Lowercase-key lookup for raw client headers
function headerValue(headers, key) {
    if (!headers || typeof headers !== "object") return null;
    return normalizeSessionId(headers[key] ?? headers[key.toLowerCase()]);
}

// Read client-provided session id from headers/body (no generation)
// Antigravity envelope carries session in request.sessionId; requestId embeds conversation uuid
const ANTIGRAVITY_CONV_RE = /^[a-z]+\/([0-9a-f-]{36})\//i;
function extractAntigravitySession(body) {
    const sid = body?.request?.sessionId;
    if (sid != null && sid !== "") return normalizeSessionId(String(sid));
    const m = typeof body?.requestId === "string" ? body.requestId.match(ANTIGRAVITY_CONV_RE) : null;
    return m ? normalizeSessionId(m[1]) : null;
}

/**
 * Scopes that must NOT treat `x-client-request-id` as a session identifier.
 *
 * CodeArts Doer limits each account to 3 *live* upstream sessions, and the
 * limit counts distinct session ids rather than in-flight requests. A client
 * that sends a fresh `x-client-request-id` per request (the default for most
 * HTTP libraries) would therefore open a new upstream session on every call —
 * the 4th request then waits for the upstream to recycle a slot, which takes
 * 40–45 seconds. Ignoring the one-shot request id keeps one conversation on
 * one upstream session, so the requests of a single conversation no longer
 * queue behind each other.
 */
const SCOPES_IGNORING_CLIENT_REQUEST_ID = new Set(["codearts-cn"]);

/**
 * Scopes whose session id is derived from the conversation's first user
 * message instead of the accumulated assistant text.
 *
 * The assistant-text hash changes whenever the first reply is shorter than
 * ASSISTANT_MIN_LEN: the first turn falls back to the per-connection id and the
 * second turn switches to the hash, so one conversation briefly occupies two
 * upstream sessions. Hashing the first user message is stable from turn one —
 * the user does not rewrite their opening question.
 */
const SCOPES_KEYED_ON_FIRST_USER_MESSAGE = new Set(["codearts-cn"]);

function firstUserMessageText(body) {
    const items = requestMessages(body);
    if (!items) return "";
    for (const item of items) {
        if (item?.role !== "user") continue;
        if (typeof item.content === "string") return item.content;
        if (Array.isArray(item.content)) {
            const text = item.content
                .map((c) => (typeof c === "string" ? c : c?.text || c?.content || ""))
                .join("");
            if (text) return text;
        }
    }
    return "";
}

// Stable session id keyed on the first user message of the conversation.
function firstUserMessageSessionId(scope, body) {
    const text = firstUserMessageText(body);
    if (!text) return null;
    const hash = sha16(`${scope}:${text.slice(0, ASSISTANT_CAP_LEN)}`);
    const existing = firstUserSessionStore.get(hash);
    if (existing) {
        existing.lastUsed = Date.now();
        return existing.sessionId;
    }
    if (firstUserSessionStore.size >= MAX_ASSISTANT_SESSIONS) {
        firstUserSessionStore.delete(firstUserSessionStore.keys().next().values().next().value);
    }
    const sessionId = generateBinaryStyleId();
    firstUserSessionStore.set(hash, { sessionId, lastUsed: Date.now() });
    return sessionId;
}

function extractClientSessionId(headers, body, scope = "") {
    // Claude Code sends the session in a header AND in metadata.user_id; the header
    // survives translation to formats that drop metadata (e.g. Responses API).
    const claude = extractClaudeCodeSession(body?.metadata?.user_id)
        || headerValue(headers, CLAUDE_CODE_SESSION_HEADER);
    if (claude) return `claude:${claude}`;
    const antigravity = extractAntigravitySession(body);
    if (antigravity) return `antigravity:${antigravity}`;
    for (const key of SESSION_HEADER_KEYS) {
        const v = headerValue(headers, key);
        if (v) return v;
    }
    const ignoreClientRequestId = scope === "kiro" || SCOPES_IGNORING_CLIENT_REQUEST_ID.has(scope);
    const requestId = ignoreClientRequestId ? null : headerValue(headers, "x-client-request-id");
    if (requestId) return requestId;
    const fromBody =
        normalizeSessionId(body?.prompt_cache_key) ||
        normalizeSessionId(body?.session_id) ||
        normalizeSessionId(body?.conversation_id) ||
        (ignoreClientRequestId ? null : normalizeSessionId(body?.metadata?.user_id));
    return fromBody || null;
}

function requestMessages(body) {
    if (Array.isArray(body?.messages)) return body.messages;
    if (Array.isArray(body?.input)) return body.input;
    return [];
}

// Accumulate assistant text from OpenAI/Responses-style input/messages (cap-limited)
function accumulateAssistantText(body) {
    const items = requestMessages(body);
    if (!items) return "";
    let text = "";
    for (const item of items) {
        if (item?.role !== "assistant") continue;
        if (typeof item.content === "string") text += item.content;
        else if (Array.isArray(item.content)) {
            for (const c of item.content) text += c?.text || c?.output || "";
        }
        if (text.length >= ASSISTANT_CAP_LEN) break;
    }
    return text;
}

// Stable session id keyed on accumulated assistant text (avoids collision on identical first user prompt)
function assistantTextSessionId(scope, body) {
    const text = accumulateAssistantText(body);
    if (text.length < ASSISTANT_MIN_LEN) return null;
    const hash = sha16(`${scope}:${text.slice(0, ASSISTANT_CAP_LEN)}`);
    const existing = assistantSessionStore.get(hash);
    if (existing) {
        existing.lastUsed = Date.now();
        return existing.sessionId;
    }
    if (assistantSessionStore.size >= MAX_ASSISTANT_SESSIONS) {
        assistantSessionStore.delete(assistantSessionStore.keys().next().value);
    }
    const sessionId = generateBinaryStyleId();
    assistantSessionStore.set(hash, { sessionId, lastUsed: Date.now() });
    return sessionId;
}

/**
 * Resolve a conversation-stable session id (generalizes Codex resolveCacheSessionId).
 * Priority: client session → accumulated-assistant-text hash → workspaceId → per-connection.
 *
 * @param {object} opts
 * @param {object} [opts.headers] - Raw client request headers (lowercase keys)
 * @param {object} [opts.body] - Parsed request body
 * @param {string} [opts.connectionId] - Connection identifier (fallback scope)
 * @param {string} [opts.workspaceId] - Provider workspace id (account-wide fallback)
 * @param {string} [opts.scope] - Provider scope to isolate cache keys across providers
 * @returns {{sessionId: string, ephemeral: boolean}} A session id plus whether it is one-shot
 */
export function resolveSessionIdentity({ headers, body, connectionId, workspaceId, scope = "" } = {}) {
    const client = extractClientSessionId(headers, body, scope);
    if (client) return { sessionId: client, ephemeral: false };
    if (SCOPES_KEYED_ON_FIRST_USER_MESSAGE.has(scope)) {
        // The first user message identifies the conversation from turn one and
        // never changes, so a conversation keeps one upstream session for its
        // whole life — no slot juggling, no 40-second waits.
        const fromFirstUser = firstUserMessageSessionId(`${scope}:${connectionId || ""}`, body);
        if (fromFirstUser) return { sessionId: fromFirstUser, ephemeral: false };
        return { sessionId: deriveSessionId(connectionId), ephemeral: false };
    }
    const fromAssistant = scope === "kiro" ? null : assistantTextSessionId(`${scope}:${connectionId || ""}`, body);
    if (fromAssistant) return { sessionId: fromAssistant, ephemeral: false };
    const ws = normalizeSessionId(workspaceId);
    if (ws) return { sessionId: ws, ephemeral: false };
    if (scope === "kiro") return { sessionId: generateBinaryStyleId(), ephemeral: true };
    return { sessionId: deriveSessionId(connectionId), ephemeral: false };
}

export function resolveSessionId(opts = {}) {
    return resolveSessionIdentity(opts).sessionId;
}

export function resolveContinuationId({ sessionId, connectionId, scope = "", ephemeral = false } = {}) {
    if (ephemeral) return crypto.randomUUID();
    const key = `${scope}:${connectionId || ""}:${sessionId || ""}`;
    const existing = continuationStore.get(key);
    if (existing) {
        existing.lastUsed = Date.now();
        continuationStore.delete(key);
        continuationStore.set(key, existing);
        return existing.continuationId;
    }
    const continuationId = crypto.randomUUID();
    if (continuationStore.size >= MAX_CONTINUATION_SESSIONS) {
        continuationStore.delete(continuationStore.keys().next().value);
    }
    continuationStore.set(key, { continuationId, lastUsed: Date.now() });
    return continuationId;
}

// Capture session id from request body + credentials (envelope still intact here)
export function captureSessionId(body, credentials, connectionId, scope = "") {
    return resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId, scope });
}

// Convert any session id to Antigravity numeric format "-<int64>" (matches real AG / CLIProxyAPI).
// Already-numeric ids (native AG sessionId) pass through unchanged.
export function toNumericSessionId(sessionId) {
    const v = normalizeSessionId(sessionId);
    if (!v) return null;
    if (/^-?\d+$/.test(v)) return v;
    const h = crypto.createHash("sha256").update(v).digest();
    const n = h.readBigUInt64BE(0) & 0x7fffffffffffffffn;
    return `-${n.toString()}`;
}

// Cleanup expired assistant-session entries
const assistantCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of assistantSessionStore) {
        if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) assistantSessionStore.delete(key);
    }
    for (const [key, entry] of continuationStore) {
        if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) continuationStore.delete(key);
    }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (assistantCleanup.unref) assistantCleanup.unref();
