// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

// Credentials mẫu cố định (deterministic) — KHÔNG dùng Date.now/random.
const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "sk-test-APIKEY",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Provider cần executor riêng (buildUrl/buildHeaders không nằm ở DefaultExecutor) → bỏ qua ở golden này.
// Chúng được lock riêng ở 11-provider edge tests / unit test chuyên biệt.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
  // Provider có executor riêng (buildHeaders khác hẳn DefaultExecutor) — golden này
  // dựng executor bằng `new DefaultExecutor(pid)`, nên với các provider này nó
  // đo một hành vi không tồn tại. Chúng được lock riêng trong unit test chuyên biệt.
  //   codearts-cn       → CodeArtsExecutor      (IAM SDK-HMAC-SHA256 签名)
  //   codebuddy-cn/intl → CodeBuddyExecutor     (x-codebuddy-request 等)
  //   minimax-code(-global) → MinimaxCodeExecutor (User-Agent / X-Mavis-Agent-Id)
  "codearts-cn", "codebuddy-cn", "codebuddy-intl",
  "minimax-code", "minimax-code-global",
]);

// Per-process / per-request values: kimi's random device name, minimax's session UUID.
const VOLATILE_HEADERS = new Set(["x-msh-device-name", "x-mavis-session-id"]);

// Headers whose value depends on the build machine or the app version.
//
// A snapshot that pins these breaks on every release (version bump) and on
// every machine (platform / Node version / device model) — the test then fails
// for reasons that have nothing to do with the provider. Mask them instead, the
// same way the existing volatile headers are handled.
const ENV_HEADERS = new Set([
  "x-client-version",
  "x-core-version",
  "x-msh-version",
  "x-platform",              // linux / darwin / win32
  "x-platform-version",      // v22.23.2 / v24.16.0
  "x-msh-device-model",      // Linux x64 / macOS arm64
]);

// Sanitize header: khử token + field thời gian động (kimi X-Msh-Device-Id) để snapshot ổn định.
function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (VOLATILE_HEADERS.has(lower)) { out[k] = "<VOLATILE>"; continue; }
    if (ENV_HEADERS.has(lower)) { out[k] = "<ENV>"; continue; }
    if (typeof v === "string") {
      // User-Agent: chỉ mask khi nó chứa version của app — User-Agent cố định
      // (vd "CLI/2.108.1 CodeBuddy/2.108.1") là contract, phải giữ nguyên.
      if (lower === "user-agent" && /\b\d+\.\d+\.\d+\b/.test(v) && /9router/i.test(v)) {
        out[k] = "<ENV>";
        continue;
      }
      out[k] = v
        .replace(/Bearer .+/, "Bearer <TOK>")
        .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
        .replace(/kimi-\d{10,}/g, "kimi-<TS>");
      continue;
    }
    out[k] = v;
  }
  return out;
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}
