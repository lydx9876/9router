// Root shim so a bare `npx vitest run` picks up the real test config.
//
// The project's settings live in tests/vitest.config.js, but without a root
// config Vitest never loads it: `npx vitest run` then resolves no aliases at all,
// and any test importing `@/lib/...` or `open-sse/...` dies at collection with
// "Cannot find package '@/lib/dataDir.js'". The failure looks like broken test
// infrastructure rather than a config problem, so it is easy to misdiagnose.
//
// Keeping one source of truth and re-exporting it avoids the two files drifting.
export { default } from "./tests/vitest.config.js";
