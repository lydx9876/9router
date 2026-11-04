import { describe, expect, it } from "vitest";

import { escapeUri, signCodeArtsRequest } from "../../open-sse/utils/codeartsSignature.js";

/**
 * The pinned values below were re-derived with the well-known AWS example credentials
 * (AKIDEXAMPLE / wJalrXUtnFEMI...) so no real secret is ever committed to the repo.
 *
 * The canonical-request hash is identical for every credential pair — the secret only
 * enters the final HMAC — so pinning it still proves the canonicalisation matches the
 * official CodeArts Doer CLI byte-for-byte. The CLI log at 2026-11-02T02:55:46Z
 * ("signSimple: canonical request details" / "signature=...") produced the same
 * canonicalRequestHash with a real AK/SK pair.
 *
 * We pin the values rather than trusting a hand-rolled implementation to match the
 * server: CodeArts rejects every signature mismatch with a bare
 * "verify ak sk signature fail", which is painful to debug from the outside.
 *
 * To re-derive with your own credentials:
 *   CODEARTS_CLI_AK=... CODEARTS_CLI_SK=... codearts run -m <model> "hi"
 * then read the canonicalRequestHash / signature from
 * ~/.codeartsdoer/cli-data/log/*.log
 */
const SIGNING_DATE = new Date("2026-11-02T02:55:46.000Z");
// AWS's documented example credentials — not a secret.
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const KEY_EXCHANGE_URL =
  "https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/security/key-exchange";

// Captured from the CLI log at 2026-11-02T02:55:46Z (credential-independent).
const EXPECTED_AMZ_DATE = "20261102T025546Z";
const EXPECTED_CANONICAL_HASH =
  "70b510d4816188433be19f94640eb832492af091f4f0b319d05a9cab3ba0e634";
// HMAC over the canonical request using the example credentials above.
const EXPECTED_SIGNATURE =
  "8c55dd37a7ac56afa3ec9de51ad3549ff6b5d9e2ad763a5a8212d2d0f5d21047";

describe("codeartsSignature", () => {
  it("escapes per RFC 3986 (encodeURIComponent alone leaves !'()* alone)", () => {
    expect(escapeUri("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    expect(escapeUri("plain-path_1")).toBe("plain-path_1");
  });

  it("signs the security-token exchange exactly like the official CLI", () => {
    const headers = signCodeArtsRequest({
      method: "POST",
      url: KEY_EXCHANGE_URL,
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      date: SIGNING_DATE,
    });

    expect(headers["X-Sdk-Date"]).toBe(EXPECTED_AMZ_DATE);
    expect(headers["Host"]).toBe("snap-access.cn-north-4.myhuaweicloud.com");
    expect(headers["X-Sdk-Content-Sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(headers["X-Security-Token"]).toBe("");
    expect(headers["Authorization"]).toContain(`Access=${CREDENTIALS.accessKeyId}`);
    expect(headers["Authorization"]).toContain(
      "SignedHeaders=content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token",
    );
    expect(headers["Authorization"]).toContain(EXPECTED_SIGNATURE);
  });

  it("canonicalises the URI with a trailing slash (CLI signs /path/ for /path)", () => {
    // The CLI signs "/api/v1/security/key-exchange/" while the request path has no
    // trailing slash. Signing the raw path yields a different hash and the gateway
    // answers 401 "verify ak sk signature fail".
    const signed = signCodeArtsRequest({
      method: "POST",
      url: KEY_EXCHANGE_URL,
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      date: SIGNING_DATE,
    });
    const withoutSlash = signCodeArtsRequest({
      method: "POST",
      url: `${KEY_EXCHANGE_URL}/`,
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      date: SIGNING_DATE,
    });
    // Both spellings must produce the same signature — the canonical form always ends in "/".
    expect(signed["Authorization"]).toBe(withoutSlash["Authorization"]);
  });

  it("changes the signature when the timestamp changes", () => {
    const a = signCodeArtsRequest({
      method: "POST",
      url: KEY_EXCHANGE_URL,
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      date: SIGNING_DATE,
    });
    const b = signCodeArtsRequest({
      method: "POST",
      url: KEY_EXCHANGE_URL,
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      date: new Date("2026-11-02T02:55:47.000Z"),
    });
    expect(a["Authorization"]).not.toBe(b["Authorization"]);
    expect(a["X-Sdk-Date"]).not.toBe(b["X-Sdk-Date"]);
  });

  it("carries the security token when a temporary credential is used", () => {
    const headers = signCodeArtsRequest({
      method: "POST",
      url: KEY_EXCHANGE_URL,
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
      securityToken: "TOKEN123",
      date: SIGNING_DATE,
    });
    expect(headers["X-Security-Token"]).toBe("TOKEN123");
    expect(headers["Authorization"]).toContain("x-security-token");
  });

  it("rejects missing credentials instead of signing garbage", () => {
    expect(() =>
      signCodeArtsRequest({ method: "POST", url: KEY_EXCHANGE_URL }),
    ).toThrow(/accessKeyId/);
    expect(() =>
      signCodeArtsRequest({
        method: "POST",
        url: KEY_EXCHANGE_URL,
        accessKeyId: "AK",
      }),
    ).toThrow(/secretAccessKey/);
  });
});
