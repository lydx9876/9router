import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * TRAE CN OAuth — the parts that fail silently.
 *
 * Every assertion here corresponds to a documented failure mode observed against
 * the live portal, not a hypothetical:
 *
 *  - a missing authorize param leaves the page stuck on "authorizing" forever,
 *    with no error shown
 *  - the wrong client_id answers 404
 *  - honoring `host` from the callback would let a crafted URL redirect the
 *    refresh token to an arbitrary origin
 *  - ExchangeToken answers HTTP 200 with a business-error envelope, so checking
 *    `res.ok` alone reports success on a rejected credential
 */

const {
  buildTraeCnAuthUrl,
  buildTraeCnDeviceContext,
  parseTraeCnCallback,
  exchangeTraeCnToken,
  importTraeCnCredential,
} = await import("../../src/lib/oauth/providers/trae-cn.js");
const { TRAE_CN_CONFIG } = await import("../../src/lib/oauth/constants/traeCn.js");

const UID = "1282504328491419";

function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

describe("TRAE CN device identity", () => {
  it("produces the two 15-digit numeric ids the portal requires", () => {
    const ctx = buildTraeCnDeviceContext(UID);
    expect(ctx.machineId).toMatch(/^\d{15}$/);
    expect(ctx.deviceId).toMatch(/^\d{15}$/);
  });

  it("is stable for one account and distinct across accounts", () => {
    expect(buildTraeCnDeviceContext(UID)).toEqual(buildTraeCnDeviceContext(UID));
    expect(buildTraeCnDeviceContext(UID).deviceId)
      .not.toBe(buildTraeCnDeviceContext("9999999999999999").deviceId);
  });
});

describe("TRAE CN authorize URL", () => {
  const url = buildTraeCnAuthUrl({
    loginTraceId: "6520317522506879",
    callbackUrl: "http://127.0.0.1:49782/callback",
    machineId: "268425369303491",
    deviceId: "500966969391093",
  });
  const parsed = Object.fromEntries(new URL(url).searchParams);

  it("carries every parameter the portal demands", () => {
    // Omitting any one of these leaves the page stuck on "authorizing" and it
    // never redirects — a silent hang, not an error.
    for (const key of [
      "login_version", "auth_from", "login_channel", "plugin_version", "auth_type",
      "client_id", "redirect", "login_trace_id", "auth_callback_url",
      "machine_id", "device_id", "x_device_id", "x_machine_id",
      "x_device_brand", "x_device_type", "x_os_version", "x_app_version", "x_app_type",
    ]) {
      expect(parsed[key], `missing authorize param ${key}`).toBeTruthy();
    }
  });

  it("uses the CN SOLO client id, not the intl web one", () => {
    // The intl id (ono9krqynydwx5) is answered with a 404 by the CN portal.
    expect(parsed.client_id).toBe("en1oxy7wnw8j9n");
  });

  it("names the callback parameter auth_callback_url", () => {
    // redirect_uri / callback_url are not recognised and produce the same hang.
    expect(parsed.auth_callback_url).toBe("http://127.0.0.1:49782/callback");
    expect(parsed.redirect_uri).toBeUndefined();
  });

  it("points at the CN console", () => {
    const u = new URL(url);
    expect(u.origin).toBe("https://www.trae.cn");
    expect(u.pathname).toBe("/authorization");
  });

  it("uses the /authorize callback path the portal's invalidUrl guard requires", () => {
    // The authorization page's client bundle rejects auth_callback_url unless it
    // matches /^http:\/\/127\.0\.0\.1:(\d+)\/authorize$/: with /callback it
    // renders "登录失败 / 网络错误，请刷新页面重试" before any sign-in API call.
    expect(TRAE_CN_CONFIG.callbackPath).toBe("/authorize");
  });
});

describe("TRAE CN callback parsing", () => {
  const full =
    "http://127.0.0.1:18080/authorize?isRedirect=true&scope=solo" +
    "&refreshToken=RT123&loginTraceID=t1&host=https%3A%2F%2Fapi.trae.com.cn" +
    "&refreshExpireAt=1809916474945&userRegion=cn" +
    `&userJwt=${encodeURIComponent(JSON.stringify({ ClientID: "en1oxy7wnw8j9n" }))}` +
    `&userInfo=${encodeURIComponent(JSON.stringify({ UserID: UID, ScreenName: "tester" }))}`;

  it("reads the tokens the callback hands over directly", () => {
    // CN does not use OAuth ?code= — the refresh token is a query param.
    const parsed = parseTraeCnCallback(full);
    expect(parsed.refreshToken).toBe("RT123");
    expect(parsed.userInfo.UserID).toBe(UID);
    expect(parsed.refreshExpireAt).toBe(1809916474945);
    expect(parsed.userRegion).toBe("cn");
    expect(parsed.scope).toBe("solo");
  });

  it("accepts a bare refresh token", () => {
    expect(parseTraeCnCallback("  bareRTvalue  ").refreshToken).toBe("bareRTvalue");
  });

  it("explains a rejected authorization instead of returning an empty result", () => {
    expect(() => parseTraeCnCallback("http://x/callback?error=access_denied")).toThrow(/access_denied/);
    expect(() => parseTraeCnCallback("http://x/callback?scope=solo")).toThrow(/no refreshToken/);
    expect(() => parseTraeCnCallback("")).toThrow(/empty/);
  });
});

describe("TRAE CN ExchangeToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(handler) {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    });
    return calls;
  }

  it("sends the empty x-cloudide-token the refresh grant expects", async () => {
    // Sending the old access token here makes the server demand a device
    // signature instead of honoring the refresh grant.
    const calls = stubFetch(() => new Response(JSON.stringify({
      Result: { Token: "newt", RefreshToken: "newrt", TokenExpireAt: Date.now() + 14 * 86400_000 },
    }), { status: 200 }));

    const out = await exchangeTraeCnToken("oldrt");
    expect(out.accessToken).toBe("newt");
    expect(out.refreshToken).toBe("newrt");
    expect(calls[0].init.headers["x-cloudide-token"]).toBe("");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      ClientID: "en1oxy7wnw8j9n",
      RefreshToken: "oldrt",
      ClientSecret: "-",
    });
  });

  it("treats a 200 carrying a business error as a failure", async () => {
    // The CN API reports a rejected credential inside a 200 envelope. Checking
    // res.ok alone would report this as a successful refresh.
    stubFetch(() => new Response(JSON.stringify({
      ResponseMetadata: { Error: { Code: 10101, Data: { "__Message.error": "refresh token is not matched to the client" } } },
    }), { status: 200 }));

    const out = await exchangeTraeCnToken("spent");
    expect(out.error).toBe("exchange_failed");
    expect(out.detail).toContain("not matched");
  });

  it("does not honor a host supplied by the callback", async () => {
    // SSRF guard: a crafted callback could otherwise point the exchange — and the
    // refresh token in its body — at an attacker-controlled origin.
    const calls = stubFetch(() => new Response(JSON.stringify({ Result: { Token: "t" } }), { status: 200 }));
    await exchangeTraeCnToken("rt");
    for (const c of calls) {
      expect(TRAE_CN_CONFIG.apiOrigins.some((o) => String(c.url).startsWith(o))).toBe(true);
    }
  });

  it("refuses to refresh without a refresh token", async () => {
    await expect(exchangeTraeCnToken("")).rejects.toThrow(/refreshToken/);
  });
});

describe("TRAE CN credential import", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("imports a pasted JWT without inventing a refresh token", async () => {
    const jwt = makeJwt({ data: { id: UID } });
    const out = await importTraeCnCredential(`Cloud-IDE-JWT ${jwt}`);
    expect(out.accessToken).toBe(jwt);
    expect(out.uid).toBe(UID);
    expect(out.refreshToken).toBeNull();
    expect(out.authMethod).toBe("imported");
    // IDE session tokens last ~8h and cannot be renewed.
    expect(out.expiresIn).toBe(8 * 60 * 60);
  });

  it("persists the ROTATED refresh token, not the spent one", async () => {
    // ExchangeToken rotates the refresh token; storing the callback's copy would
    // make the very next refresh fail.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      Result: { Token: makeJwt({ data: { id: UID } }), RefreshToken: "ROTATED" },
    }), { status: 200 }));

    const cb = `http://x/cb?refreshToken=SPENT&userInfo=${encodeURIComponent(JSON.stringify({ UserID: UID }))}`;
    const out = await importTraeCnCredential(cb);
    expect(out.refreshToken).toBe("ROTATED");
    expect(out.uid).toBe(UID);
    expect(out.authMethod).toBe("oauth");
  });
});
