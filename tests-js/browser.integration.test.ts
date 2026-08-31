import path from "node:path";
import { test } from "vitest";
import { downloadNodeKittenTtsRepoAssets } from "../src/node/repo-assets.js";
import { KITTENTTS_MODELS } from "../src/sdk/model-registry.js";
import { run } from "./helpers/process.js";

async function prepareModelMatrixAssets(): Promise<void> {
  const cacheDir = path.resolve(".context", "model-matrix-cache");
  await Promise.all(Object.values(KITTENTTS_MODELS).map((definition) =>
    downloadNodeKittenTtsRepoAssets({
      repoId: definition.repoId,
      revision: definition.revision,
      cacheDir,
      retries: 4,
      integrity: {
        "config.json": definition.configSha256,
        [definition.modelFilename]: definition.modelSha256,
        [definition.voicesFilename]: definition.voicesSha256,
      },
    })
  ));
}

test("packed browser consumers pass direct, fallback, and worker modes", async () => {
  const selectedCase = process.env.KITTENTTS_BROWSER_CONSUMER_CASE;
  await run(process.execPath, [
    "tests-js/verification/packed-browser-consumer.mjs",
    ...(selectedCase ? ["--case", selectedCase] : []),
  ]);
});

test("browser example loads pinned repository assets directly", async () => {
  await run(process.execPath, ["tests-js/verification/chrome-driver.mjs", "--repo"]);
});

test("browser example loads pinned repository assets in a worker", async () => {
  await run(process.execPath, ["tests-js/verification/chrome-driver.mjs", "--transport", "worker", "--repo"]);
});

test("all registered browser models pass WASM and offline-cache verification", async () => {
  await prepareModelMatrixAssets();
  await run(process.execPath, [
    "tests-js/verification/chrome-driver.mjs",
    "--page-path",
    "/web/model-matrix.html",
    "--execution-mode",
    "wasm",
    "--timeout-ms",
    "600000",
  ]);
});

test("explicit WebGPU uses the WebGPU execution provider", async () => {
  await run(process.execPath, [
    "tests-js/verification/chrome-driver.mjs",
    "--repo",
    "--execution-mode",
    "webgpu",
    "--enable-webgpu",
    "--require-provider",
    "webgpu",
  ]);
});
