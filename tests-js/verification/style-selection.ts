import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ort from "onnxruntime-node";
import {
  AUDIO_TOLERANCES,
  audioDeltas,
  type FixtureManifest,
  summarizeAudio,
  trimModelAudio,
} from "../../src/core/phoneme-feeds.js";
import { loadVoicesNpz, selectStyleRow } from "../../src/core/voices-npz.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, ".context", "reference-fixtures", "manifest.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function verifyStyleSelectionParity(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as FixtureManifest;
  assert(manifest.voices_asset_path, "voices asset path missing from manifest");

  const voicesBytes = new Uint8Array(
    await fs.readFile(path.join(repoRoot, ".context", "reference-fixtures", manifest.voices_asset_path)),
  );
  const voices = loadVoicesNpz(voicesBytes);
  let checkedChunks = 0;

  for (const fixtureCase of manifest.cases) {
    for (const chunk of fixtureCase.chunks) {
      const voice = voices[chunk.resolved_voice];
      assert(voice, `missing voice '${chunk.resolved_voice}' in voices.npz`);

      const selected = selectStyleRow(voice, chunk.text.length);
      assert(
        selected.refId === chunk.ref_id,
        `ref id mismatch for ${fixtureCase.id} chunk ${chunk.index}: ${selected.refId} !== ${chunk.ref_id}`,
      );
      assert(
        selected.styleShape[0] === chunk.style_shape[0] && selected.styleShape[1] === chunk.style_shape[1],
        `style shape mismatch for ${fixtureCase.id} chunk ${chunk.index}`,
      );
      const expectedStyle = chunk.style[0];
      assert(expectedStyle, `missing expected style row for ${fixtureCase.id} chunk ${chunk.index}`);
      for (let index = 0; index < selected.style.length; index += 1) {
        if (selected.style[index] !== expectedStyle[index]) {
          throw new Error(
            `style mismatch for ${fixtureCase.id} chunk ${chunk.index} at ${index}: ` +
              `${selected.style[index]} !== ${expectedStyle[index]}`,
          );
        }
      }
      checkedChunks += 1;
    }
  }

  const fixtureCase = manifest.cases[0];
  assert(fixtureCase, "no fixture cases found");
  const chunk = fixtureCase.chunks[0];
  assert(chunk, "no chunks found in first fixture case");
  const voice = voices[chunk.resolved_voice];
  assert(voice, `missing voice '${chunk.resolved_voice}' in voices.npz`);
  const selected = selectStyleRow(voice, chunk.text.length);

  const session = await ort.InferenceSession.create(manifest.model_path);
  const outputs = await session.run({
    input_ids: new ort.Tensor(
      "int64",
      BigInt64Array.from(chunk.input_ids.map((value) => BigInt(value))),
      [1, chunk.input_ids.length],
    ),
    style: new ort.Tensor("float32", selected.style, selected.styleShape),
    speed: new ort.Tensor("float32", Float32Array.from(chunk.speed), [chunk.speed.length]),
  });
  const firstOutput = outputs[session.outputNames[0]];
  assert(firstOutput, "model returned no output");
  assert(firstOutput.data instanceof Float32Array, "expected Float32Array audio output");

  const actual = summarizeAudio(trimModelAudio(firstOutput.data));
  const deltas = audioDeltas(actual, chunk.audio);
  assert(actual.num_samples === chunk.audio.num_samples, "sample count mismatch for style selection check");
  for (const [metric, tolerance] of Object.entries(AUDIO_TOLERANCES)) {
    const delta = deltas[metric as keyof typeof deltas];
    if (delta > tolerance) {
      throw new Error(`${metric} delta ${delta} exceeds tolerance ${tolerance}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        checkedChunks,
        rebuiltCaseId: fixtureCase.id,
        rebuiltChunkIndex: chunk.index,
        deltas,
      },
      null,
      2,
    ),
  );
}
