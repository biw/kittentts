import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests-js/**/*.test.ts"],
    globalSetup: ["tests-js/global-setup.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 900_000,
    hookTimeout: 900_000,
    reporters: ["verbose"],
  },
});
