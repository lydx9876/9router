import { createHash } from "node:crypto";

/**
 * TRAE CN (www.trae.cn Trae IDE) identity derivation.
 *
 * ## Why this exists
 *
 * TRAE's IDE endpoints require the client to present the *same* device identity on
 * every request. Generating a random machine id per request makes each call look
 * like a brand-new device, and upstream answers:
 *
 *   {"code":4011,"message":"We're sorry, your requests have exceeded the rate limit."}
 *
 * That reads like rate limiting but is a device-identity rejection: waiting does not
 * clear it. Verified live — switching from a random id to the derived one below made
 * 4011 disappear immediately and returned a normal stream.
 *
 * The derivation is deterministic from the account uid so the same account always
 * presents the same machine. Different accounts must never share one: TRAE treats a
 * shared device as the same machine, which is the shape that gets accounts flagged.
 *
 * ## Algorithm
 *
 * Ported from Lamp-Guide (`internal/zen/chprov/registry.go`, Go), which in turn
 * matched the reference implementation byte for byte:
 *
 *   seededBytes(seed, salt, n) = SHA256(seed|salt|0) ++ SHA256(seed|salt|1) ++ ...  take first n
 *
 * The `|` separator and the counter being decimal are both part of the match — a
 * different separator produces valid-looking ids that upstream rejects.
 */

const SALT_DEVICE_ID = "devid";
const SALT_MARKET_USER = "market";
const SALT_TRACE = "trace";
const SALT_SESSION = "session";

/** Deterministic byte stream: SHA256(seed|salt|counter) concatenated, truncated to n. */
export function seededBytes(seed, salt, n) {
  const out = [];
  const seedStr = String(seed ?? "");
  for (let i = 0; out.length < n; i += 1) {
    const digest = createHash("sha256").update(`${seedStr}|${salt}|${i}`).digest();
    for (const b of digest) {
      out.push(b);
      if (out.length >= n) break;
    }
  }
  return Buffer.from(out);
}

/** n decimal digits, one per byte (byte % 10). TRAE's x-device-id is 15 of these. */
export function seededDigits(n, seed, salt) {
  const bytes = seededBytes(seed, salt, n);
  let out = "";
  for (const b of bytes) out += String(b % 10);
  return out;
}

/** n hex chars from the seeded stream. */
export function seededHex(n, seed, salt) {
  const bytes = seededBytes(seed, salt, Math.ceil(n / 2));
  return bytes.toString("hex").slice(0, n);
}

/** Deterministic UUID v4 (version/variant bits forced) — TRAE's x-market-user-id. */
export function seededUuid(seed, salt) {
  const b = seededBytes(seed, salt, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The full set of identities TRAE wants, all derived from uid.
 *
 * - deviceId     15 digits    x-device-id
 * - marketUserId UUID v4      x-market-user-id
 * - machineId    64 hex       x-machine-id
 * - traceId      "00-<16 hex>-01"   x-tt-trace-id
 * - sessionId    16 hex       vscode-sessionid
 * - requestId    UUID v4      x-request-id
 *
 * Verified for uid 1282504328491419 → deviceId 500966969391093.
 */
export function deriveTraeCnIdentity(uid) {
  const seed = String(uid ?? "").trim();
  if (!seed) {
    throw new Error("trae-cn: cannot derive device identity without a uid");
  }
  return {
    deviceId: seededDigits(15, seed, SALT_DEVICE_ID),
    marketUserId: seededUuid(seed, SALT_MARKET_USER),
    // x-machine-id is 64 hex (openssl rand -hex 32 equivalent).
    machineId: seededHex(64, seed, "machine"),
    traceId: `00-${seededHex(16, seed, SALT_TRACE)}-01`,
    sessionId: seededHex(16, seed, SALT_SESSION),
    requestId: seededUuid(seed, "req"),
  };
}
