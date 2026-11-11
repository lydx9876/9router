import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Vite's array form matches `find` **literally** — a RegExp entry is accepted
    // at config time but never matches, so every `@/…` import failed to resolve and
    // any test touching src/ died with "Cannot find package '@/lib/…'". The string
    // form resolves as a prefix, which is what these aliases need:
    //   open-sse/foo.js → <repo>/open-sse/foo.js
    //   @/lib/usageDb.js → <repo>/src/lib/usageDb.js
    alias: {
      "open-sse/": resolve(__dirname, "../open-sse") + "/",
      "@/": resolve(__dirname, "../src") + "/",
    },
  },
});
