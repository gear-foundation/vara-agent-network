import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // ESM-aware; the indexer is `"type": "module"` in package.json.
    pool: "forks",
    // Tests share an in-memory DB via pg-mem; run sequentially within a file
    // to avoid bleed across test cases that mutate the same tables.
    fileParallelism: false,
  },
});
