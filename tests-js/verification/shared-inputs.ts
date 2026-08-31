import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ort from "onnxruntime-node";
import {
  AUDIO_TOLERANCES,
  audioDeltas,
  buildChunkFeeds,
  type FixtureManifest,
  summarizeAudio,
  tokenizePhonemes,
  trimModelAudio,
} from "../../src/core/phoneme-feeds.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, ".context", "reference-fixtures", "manifest.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function verifySharedInputsParity(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as FixtureManifest;
  let chunkCount = 0;

  for (const fixtureCase of manifest.cases) {
    for (const chunk of fixtureCase.chunks) {
      chunkCount += 1;
      const tokenized = tokenizePhonemes(chunk.phonemes_raw);
      assert(
        tokenized === chunk.phonemes_tokenized,
        `tokenized phonemes mismatch for ${fixtureCase.id} chunk ${chunk.index}`,
      );

      const feeds = buildChunkFeeds(chunk);
      assert(
        feeds.inputIds.length === chunk.input_ids.length,
        `input length mismatch for ${fixtureCase.id} chunk ${chunk.index}`,
      );
      for (let index = 0; index < feeds.inputIds.length; index += 1) {
        if (feeds.inputIds[index] !== chunk.input_ids[index]) {
          throw new Error(
            `input id mismatch for ${fixtureCase.id} chunk ${chunk.index} at ${index}: ` +
              `${feeds.inputIds[index]} !== ${chunk.input_ids[index]}`,
          );
        }
      }
    }
  }

  const fixtureCase = manifest.cases[0];
  assert(fixtureCase, "no fixture cases found");
  const chunk = fixtureCase.chunks[0];
  assert(chunk, "no chunks found in first fixture case");

  const rebuilt = buildChunkFeeds(chunk);
  const session = await ort.InferenceSession.create(manifest.model_path);
  const outputs = await session.run({
    input_ids: new ort.Tensor(
      "int64",
      BigInt64Array.from(rebuilt.inputIds.map((value) => BigInt(value))),
      [1, rebuilt.inputIds.length],
    ),
    style: new ort.Tensor(
      "float32",
      Float32Array.from(rebuilt.style.flat()),
      rebuilt.styleShape,
    ),
    speed: new ort.Tensor("float32", Float32Array.from(rebuilt.speed), [rebuilt.speed.length]),
  });
  const firstOutput = outputs[session.outputNames[0]];
  assert(firstOutput, "model returned no output");
  assert(firstOutput.data instanceof Float32Array, "expected Float32Array audio output");

  const actual = summarizeAudio(trimModelAudio(firstOutput.data));
  const deltas = audioDeltas(actual, chunk.audio);
  assert(actual.num_samples === chunk.audio.num_samples, "sample count mismatch for rebuilt feeds");
  for (const [metric, tolerance] of Object.entries(AUDIO_TOLERANCES)) {
    const delta = deltas[metric as keyof typeof deltas];
    if (delta > tolerance) {
      throw new Error(`${metric} delta ${delta} exceeds tolerance ${tolerance}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        cases: manifest.cases.length,
        chunks: chunkCount,
        rebuiltCaseId: fixtureCase.id,
        rebuiltChunkIndex: chunk.index,
        deltas,
      },
      null,
      2,
    ),
  );
}
