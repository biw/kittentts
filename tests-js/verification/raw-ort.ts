import fs from "node:fs/promises";
import path from "node:path";
import ort from "onnxruntime-node";
import {
  AUDIO_TOLERANCES,
  audioDeltas,
  type FixtureManifest,
  summarizeAudio,
  trimModelAudio,
} from "../../src/core/phoneme-feeds.js";

export async function verifyRawNodeOrt(caseId?: string): Promise<void> {
  const manifest = JSON.parse(
    await fs.readFile(path.resolve(".context/reference-fixtures/manifest.json"), "utf8"),
  ) as FixtureManifest;
  const fixtureCase = caseId
    ? manifest.cases.find((entry) => entry.id === caseId)
    : manifest.cases[0];
  if (!fixtureCase) {
    throw new Error(caseId ? `case '${caseId}' not found` : "no fixture cases found");
  }
  const chunk = fixtureCase.chunks[0];
  if (!chunk) throw new Error(`case '${fixtureCase.id}' has no chunks`);

  const session = await ort.InferenceSession.create(manifest.model_path);
  const outputs = await session.run({
    input_ids: new ort.Tensor(
      "int64",
      BigInt64Array.from(chunk.input_ids.map((value) => BigInt(value))),
      [1, chunk.input_ids.length],
    ),
    style: new ort.Tensor("float32", Float32Array.from(chunk.style.flat()), chunk.style_shape),
    speed: new ort.Tensor("float32", Float32Array.from(chunk.speed), [chunk.speed.length]),
  });
  const firstOutput = outputs[session.outputNames[0]];
  if (!firstOutput || !(firstOutput.data instanceof Float32Array)) {
    throw new Error("model returned no Float32Array output");
  }

  const actual = summarizeAudio(trimModelAudio(firstOutput.data));
  const deltas = audioDeltas(actual, chunk.audio);
  if (actual.num_samples !== chunk.audio.num_samples) {
    throw new Error(
      `sample count mismatch: got ${actual.num_samples}, expected ${chunk.audio.num_samples}`,
    );
  }
  for (const [metric, tolerance] of Object.entries(AUDIO_TOLERANCES)) {
    const delta = deltas[metric as keyof typeof deltas];
    if (delta > tolerance) {
      throw new Error(`Node ORT ${metric} delta ${delta} exceeds tolerance ${tolerance}`);
    }
  }
}
