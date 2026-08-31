import { test } from "vitest";
import { verifyFixturePhonemizerPipeline } from "./verification/fixture-pipeline.js";
import { verifyJsPhonemizerPipeline } from "./verification/js-pipeline.js";
import { verifyModelMatrix } from "./verification/model-matrix.js";
import { verifyNodeRuntime } from "./verification/node-runtime.js";
import { verifyPhonemizerParity } from "./verification/phonemizer.js";
import { verifyPreprocessingParity } from "./verification/preprocessing.js";
import { verifyRawNodeOrt } from "./verification/raw-ort.js";
import { verifyRepositoryAssets } from "./verification/repository-assets.js";
import { verifySharedInputsParity } from "./verification/shared-inputs.js";
import { verifyStyleSelectionParity } from "./verification/style-selection.js";

const verifiers = [
  ["preprocessing matches Python", verifyPreprocessingParity],
  ["phonemizer matches Python", verifyPhonemizerParity],
  ["shared model inputs match Python", verifySharedInputsParity],
  ["voice style selection matches Python", verifyStyleSelectionParity],
  ["fixture phonemizer pipeline matches Python", verifyFixturePhonemizerPipeline],
  ["JavaScript phonemizer pipeline matches Python", verifyJsPhonemizerPipeline],
  ["repository asset loading is secure and cacheable", verifyRepositoryAssets],
  ["Node runtime matches the complete reference corpus", verifyNodeRuntime],
  ["all registered models match Python bounds", verifyModelMatrix],
] as const;

for (const [name, verify] of verifiers) {
  test(name, async () => {
    await verify();
  });
}

test("raw Node ONNX Runtime output matches Python bounds", async () => {
  await verifyRawNodeOrt();
});
