import { statSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { runWebDriverExample } from "./helpers/webdriver.js";

const shouldSkip = process.env.KITTENTTS_FIREFOX !== "1";
const firefoxTest = test.skipIf(shouldSkip);
const geckoDriver = (() => {
  const configured = process.env.GECKOWEBDRIVER;
  if (!configured) return "geckodriver";
  try {
    if (statSync(configured).isDirectory()) {
      return path.join(configured, process.platform === "win32" ? "geckodriver.exe" : "geckodriver");
    }
  } catch {
    // Let spawn report a precise error for an invalid configured path.
  }
  return configured;
})();

for (const transport of ["main", "worker"] as const) {
  firefoxTest(`Firefox synthesizes with ${transport}-thread WASM`, async () => {
    const binary = process.env.FIREFOX_BIN;
    await runWebDriverExample({
      browserName: "firefox",
      driverCommand: geckoDriver,
      driverArgs: (port) => ["--host", "127.0.0.1", "--port", String(port)],
      capabilities: {
        browserName: "firefox",
        "moz:firefoxOptions": {
          args: ["-headless"],
          ...(binary ? { binary } : {}),
        },
      },
      executionMode: "wasm",
      transport,
      expectedProvider: "wasm",
      expectedThreads: 1,
      expectedSamples: 71_800,
    });
  });
}
