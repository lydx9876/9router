import { describe, it, expect } from "vitest";

/**
 * TRAE CN dashboard wiring.
 *
 * The panel decides which auth actions to show from the provider's category and
 * authModes, so a provider that is registered but categorized wrongly simply
 * never shows a sign-in button — a silent dead end rather than an error. These
 * assertions pin the wiring that makes both auth modes reachable.
 */

const { AI_PROVIDERS, OAUTH_PROVIDERS, APIKEY_PROVIDERS } = await import("../../src/shared/constants/providers.js");
const registry = (await import("../../open-sse/providers/registry/index.js")).default;
const { readFileSync } = await import("node:fs");
const MODAL_SRC = readFileSync(new URL("../../src/shared/components/OAuthModal.js", import.meta.url), "utf8");

describe("TRAE CN provider registration", () => {
  const provider = AI_PROVIDERS["trae-cn"];

  it("is visible to the dashboard at all", () => {
    expect(provider).toBeTruthy();
  });

  it("offers both browser sign-in and paste", () => {
    // The panel shows "sign in with browser" only for providers in
    // OAUTH_PROVIDERS or whose authModes include "oauth", and the paste form only
    // when authModes includes "apikey". Missing either leaves one flow unreachable
    // with no error — just a button that is not there.
    expect(provider.authModes).toContain("oauth");
    expect(provider.authModes).toContain("apikey");
    expect(provider.hasOAuth).toBe(true);
  });

  it("derives an OAuth category so the sign-in action appears", () => {
    expect(OAUTH_PROVIDERS["trae-cn"]).toBeTruthy();
  });

  it("keeps the dedicated two-field credential form", () => {
    // The form asks for JWT + refreshToken instead of a single API key.
    expect(provider.credentialForm).toBe("trae-cn");
  });

  it("keeps forceStream, which the executor depends on", () => {
    const entry = registry.find((r) => r.id === "trae-cn");
    expect(entry.transport?.forceStream ?? entry.forceStream).toBe(true);
  });

  it("declares usage so the panel queries it", () => {
    // features.usage -> USAGE_SUPPORTED_PROVIDERS, features.usageApikey ->
    // USAGE_APIKEY_PROVIDERS. Both are needed; the second is the one that gets
    // forgotten and leaves an apikey connection out of the panel entirely.
    const entry = registry.find((r) => r.id === "trae-cn");
    expect(entry.features?.usage).toBe(true);
    expect(entry.features?.usageApikey).toBe(true);
    expect(APIKEY_PROVIDERS["trae-cn"]).toBeFalsy(); // category is oauth; usageApikey covers it
  });
});

describe("TRAE CN OAuth modal wiring", () => {
  const src = MODAL_SRC;

  it("is routed through the local callback proxy", () => {
    // Without this the modal falls through to the device-code path and never
    // starts the loopback proxy the CN callback needs.
    const line = src.split("\n").find((l) => l.includes("PROXY_OAUTH_PROVIDERS ="));
    expect(line).toContain("\"trae-cn\"");
  });

  it("offers a paste fallback with CN-specific instructions", () => {
    // CN tokens are not interchangeable with the intl surface, so pointing users
    // at trae.ai would produce a credential that answers 1001.
    expect(src).toMatch(/"trae-cn":\s*\{/);
    const block = src.slice(src.indexOf("\"trae-cn\": {"), src.indexOf("\"trae-cn\": {") + 900);
    expect(block).toContain("trae.cn");
    expect(block).not.toMatch(/trae\.ai/);
  });

  it("documents both credential shapes in the paste hint", () => {
    // A bare JWT works but expires in ~8h; a callback URL also carries a refresh
    // token. Users need to know which they have.
    const block = src.slice(src.indexOf("\"trae-cn\": {"), src.indexOf("\"trae-cn\": {") + 900);
    expect(block).toMatch(/~8 hours/);
    expect(block).toMatch(/~180 days/);
  });
});
