// A Docker install that loses its settings on every image update is caused by
// DATA_DIR pointing somewhere the `node` user cannot write: the app falls back
// to ~/.9router (/home/node/.9router inside the container), where no volume is
// mounted, so the database dies with the container.
//
// The fallback has to say so loudly — a silent fallback is what made the
// problem hard to spot.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_WARN = console.warn;

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  console.warn = ORIGINAL_WARN;
  vi.resetModules();
});

// dataDir.js reads the environment at import time and caches the result, so
// every case needs a fresh module instance.
async function loadDataDir({ dataDir } = {}) {
  if (dataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = dataDir;
  vi.resetModules();
  return import("@/lib/dataDir.js");
}

describe("DATA_DIR resolution", () => {
  it("uses DATA_DIR when it is writable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-data-"));
    const { DATA_DIR } = await loadDataDir({ dataDir: dir });
    expect(DATA_DIR).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the home directory when DATA_DIR is not writable", async () => {
    // A path under /var that the test user cannot create.
    const unwritable = "/var/lib/9router-does-not-exist-test";
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));

    const { DATA_DIR } = await loadDataDir({ dataDir: unwritable });
    expect(DATA_DIR).toBe(path.join(os.homedir(), ".9router"));
  });

  it("warns that the fallback path is probably not the mounted volume", async () => {
    const unwritable = "/var/lib/9router-does-not-exist-test";
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));

    await loadDataDir({ dataDir: unwritable });

    const text = warnings.join("\n");
    expect(text).toContain("not writable");
    // The second warning is the one that explains the data loss.
    expect(text).toContain("DATA_DIR=/app/data");
    expect(text).toMatch(/not the path you mounted/i);
  });

  it("does not warn when DATA_DIR is writable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-data-"));
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));

    await loadDataDir({ dataDir: dir });

    expect(warnings.join("\n")).not.toContain("DATA_DIR=/app/data");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses the home directory when DATA_DIR is unset", async () => {
    const { DATA_DIR } = await loadDataDir({ dataDir: undefined });
    expect(DATA_DIR).toBe(path.join(os.homedir(), ".9router"));
  });
});
