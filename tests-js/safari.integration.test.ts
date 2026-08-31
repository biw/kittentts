import { test } from "vitest";
import { runWebDriverExample } from "./helpers/webdriver.js";

const safariTest = test.skipIf(
  process.platform !== "darwin" || process.env.KITTENTTS_SAFARI !== "1",
);
const safariWebGpuTest = test.skipIf(
  process.platform !== "darwin" ||
  process.env.KITTENTTS_SAFARI !== "1" ||
  process.env.KITTENTTS_SAFARI_WEBGPU !== "1",
);

for (const transport of ["main", "worker"] as const) {
  safariTest(`Safari synthesizes with ${transport}-thread WASM`, async () => {
    await runWebDriverExample({
      browserName: "safari",
      driverCommand: "safaridriver",
      driverArgs: (port) => ["-p", String(port)],
      capabilities: { browserName: "safari" },
      executionMode: "wasm",
      transport,
      expectedProvider: "wasm",
      expectedThreads: 1,
      expectedSamples: 71_800,
    });
  });

  safariWebGpuTest(`Safari synthesizes with ${transport}-thread WebGPU`, async () => {
      await runWebDriverExample({
        browserName: "safari",
        driverCommand: "safaridriver",
        driverArgs: (port) => ["-p", String(port)],
        capabilities: { browserName: "safari" },
        executionMode: "webgpu",
        transport,
        expectedProvider: "webgpu",
        expectedThreads: 1,
        expectedSamples: 71_800,
      });
    });
}
