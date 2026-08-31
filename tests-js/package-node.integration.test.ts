import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { run, runPnpm } from "./helpers/process.js";

test("packed Node consumer compiles and synthesizes", async () => {
  await run(process.execPath, ["tests-js/verification/packed-node-consumer.mjs"]);
});

test("documented Node example executes and writes a WAV", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "kittentts-node-example-"));
  const outputPath = path.join(outputDir, "example.wav");
  try {
    await run(process.execPath, [
      "examples/node-synthesize.mjs",
      "The documented Node example is covered by Vitest.",
      "Bruno",
      outputPath,
    ]);
    const wav = await fs.readFile(outputPath);
    if (wav.subarray(0, 4).toString("ascii") !== "RIFF" || wav.byteLength <= 44) {
      throw new Error("Node example did not write a valid WAV file");
    }
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("production dependency audit is clean", async () => {
  await runPnpm(["audit", "--prod"]);
});
