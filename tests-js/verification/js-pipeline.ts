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
import { PhonemizerJsPhonemizer } from "../../src/core/phonemizer.js";
import {
  buildPipelineFeeds,
  chunkMatchesFixture,
  pipelineConfigFromManifest,
} from "../../src/core/pipeline.js";
import { loadVoicesNpz } from "../../src/core/voices-npz.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, ".context", "reference-fixtures", "manifest.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function verifyJsPhonemizerPipeline(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as FixtureManifest;
  assert(manifest.voices_asset_path, "voices asset path missing from manifest");

  const voicesBytes = new Uint8Array(
    await fs.readFile(path.join(repoRoot, ".context", "reference-fixtures", manifest.voices_asset_path)),
  );
  const voices = loadVoicesNpz(voicesBytes);
  const phonemizer = new PhonemizerJsPhonemizer();
  const config = pipelineConfigFromManifest(manifest);

  let checkedCases = 0;
  let checkedChunks = 0;
  for (const fixtureCase of manifest.cases) {
    const pipeline = await buildPipelineFeeds({
      text: fixtureCase.text,
      voice: fixtureCase.voice,
      speed: fixtureCase.speed,
      cleanText: fixtureCase.clean_text,
      phonemizer,
      voices,
      ...config,
    });
    assert(
      pipeline.cleanedText === fixtureCase.cleaned_text,
      `cleaned text mismatch for ${fixtureCase.id}`,
    );
    assert(
      pipeline.chunks.length === fixtureCase.chunks.length,
      `chunk count mismatch for ${fixtureCase.id}`,
    );
    for (let index = 0; index < pipeline.chunks.length; index += 1) {
      const builtChunk = pipeline.chunks[index];
      const fixtureChunk = fixtureCase.chunks[index];
      assert(fixtureChunk, `missing fixture chunk ${index} for ${fixtureCase.id}`);
      if (!chunkMatchesFixture(builtChunk, fixtureChunk)) {
        throw new Error(`pipeline chunk mismatch for ${fixtureCase.id} chunk ${index}`);
      }
      checkedChunks += 1;
    }
    checkedCases += 1;
  }

  const fixtureCase = manifest.cases[0];
  assert(fixtureCase, "no fixture cases found");
  const pipeline = await buildPipelineFeeds({
    text: fixtureCase.text,
    voice: fixtureCase.voice,
    speed: fixtureCase.speed,
    cleanText: fixtureCase.clean_text,
    phonemizer,
    voices,
    ...config,
  });
  const chunk = pipeline.chunks[0];
  assert(chunk, "no pipeline chunk found for first case");

  const session = await ort.InferenceSession.create(manifest.model_path);
  const outputs = await session.run({
    input_ids: new ort.Tensor(
      "int64",
      BigInt64Array.from(chunk.inputIds.map((value) => BigInt(value))),
      [1, chunk.inputIds.length],
    ),
    style: new ort.Tensor("float32", chunk.style, chunk.styleShape),
    speed: new ort.Tensor("float32", Float32Array.from([chunk.effectiveSpeed]), [1]),
  });
  const firstOutput = outputs[session.outputNames[0]];
  assert(firstOutput, "model returned no output");
  assert(firstOutput.data instanceof Float32Array, "expected Float32Array audio output");

  const actual = summarizeAudio(trimModelAudio(firstOutput.data));
  const expected = fixtureCase.chunks[0]?.audio;
  assert(expected, "missing expected audio stats for first chunk");
  const deltas = audioDeltas(actual, expected);
  assert(actual.num_samples === expected.num_samples, "sample count mismatch for JS phonemizer pipeline");
  for (const [metric, tolerance] of Object.entries(AUDIO_TOLERANCES)) {
    const delta = deltas[metric as keyof typeof deltas];
    if (delta > tolerance) {
      throw new Error(`${metric} delta ${delta} exceeds tolerance ${tolerance}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        checkedCases,
        checkedChunks,
        rebuiltCaseId: fixtureCase.id,
        rebuiltChunkIndex: 0,
        deltas,
      },
      null,
      2,
    ),
  );
}
