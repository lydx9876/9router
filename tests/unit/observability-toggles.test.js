import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The request-details database (Usage → Details) and the deep file logs under
 * logs/ are two separate features and must have two separate switches.
 *
 * The bug this locks down: any value of ENABLE_REQUEST_LOGS — including
 * "false", which is what .env.example ships — took precedence over the Profile
 * toggle, so setting it to false silently disabled Usage → Details.
 */

const ORIGINAL_ENV = process.env.ENABLE_REQUEST_LOGS;
const ORIGINAL_OBS = process.env.OBSERVABILITY_ENABLED;

async function loadRepo({ settings, env }) {
  vi.resetModules();
  for (const key of ["ENABLE_REQUEST_LOGS", "OBSERVABILITY_ENABLED"]) {
    delete process.env[key];
  }
  if (env.ENABLE_REQUEST_LOGS !== undefined) process.env.ENABLE_REQUEST_LOGS = env.ENABLE_REQUEST_LOGS;
  if (env.OBSERVABILITY_ENABLED !== undefined) process.env.OBSERVABILITY_ENABLED = env.OBSERVABILITY_ENABLED;

  // The repo does a dynamic `import("./settingsRepo.js")` — resolved relative
  // to the repo file, so the mock has to use the same absolute path.
  const SETTINGS_REPO = new URL("../../src/lib/db/repos/settingsRepo.js", import.meta.url).href;

  vi.doMock(SETTINGS_REPO, () => ({
    getSettings: async () => settings,
  }));

  return await import("../../src/lib/db/repos/requestDetailsRepo.js");
}

const baseSettings = {
  enableObservability: false,
  enableRequestFileLogs: false,
};

describe("request details toggle independence", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.ENABLE_REQUEST_LOGS;
    else process.env.ENABLE_REQUEST_LOGS = ORIGINAL_ENV;
    if (ORIGINAL_OBS === undefined) delete process.env.OBSERVABILITY_ENABLED;
    else process.env.OBSERVABILITY_ENABLED = ORIGINAL_OBS;
    vi.doUnmock(new URL("../../src/lib/db/repos/settingsRepo.js", import.meta.url).href);
  });

  it("honours the UI toggle when ENABLE_REQUEST_LOGS is false", async () => {
    // The regression: .env.example ships ENABLE_REQUEST_LOGS=false, and that
    // used to switch the details database off regardless of the UI toggle.
    const repo = await loadRepo({
      settings: { ...baseSettings, enableObservability: true },
      env: { ENABLE_REQUEST_LOGS: "false" },
    });
    expect(await repo.getObservabilityConfigForTest()).toBe(true);
  });

  it("keeps details off when the UI toggle is off, whatever the env says", async () => {
    const repo = await loadRepo({
      settings: { ...baseSettings, enableObservability: false },
      env: {},
    });
    expect(await repo.getObservabilityConfigForTest()).toBe(false);
  });

  it("lets OBSERVABILITY_ENABLED=true force details on", async () => {
    const repo = await loadRepo({
      settings: { ...baseSettings, enableObservability: false },
      env: { OBSERVABILITY_ENABLED: "true" },
    });
    expect(await repo.getObservabilityConfigForTest()).toBe(true);
  });

  it("does not let the file-log env var drive the details database", async () => {
    // ENABLE_REQUEST_LOGS=true must not silently turn the details database on —
    // the two are independent.
    const repo = await loadRepo({
      settings: { ...baseSettings, enableObservability: false },
      env: { ENABLE_REQUEST_LOGS: "true" },
    });
    expect(await repo.getObservabilityConfigForTest()).toBe(false);
  });
});
