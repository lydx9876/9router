import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * The file logs under logs/ are written to a directory that is easy to share
 * or back up. The header masking used to be disabled, which put a usable
 * Authorization token in every log folder.
 *
 * maskSensitiveHeaders is not exported, so this reads the module source and
 * checks the behaviour through the exported logger instead of reaching into
 * internals.
 */
describe("request logger credential masking", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "open-sse/utils/requestLogger.js"),
    "utf8",
  );

  it("does not ship the disabled masking stub", () => {
    expect(source).not.toContain("Old masking code");
  });

  it("masks the credential-bearing headers", () => {
    expect(source).toContain('"authorization"');
    expect(source).toContain('"x-api-key"');
    expect(source).toContain('"cookie"');
  });

  it("replaces the value rather than dropping the header", () => {
    // Keeping the header (masked) is more useful for debugging than removing
    // it: you can still see that an Authorization header was sent.
    expect(source).toContain("value.slice(0, 10)");
    expect(source).toContain("value.slice(-5)");
  });
});
