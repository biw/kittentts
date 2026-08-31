import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { summarizeAudio } from "../../src/core/phoneme-feeds.js";
import { createNodeKittenTts } from "../../src/node/runtime.js";
import { KITTENTTS_MODELS, type KittenTtsModelDefinition } from "../../src/sdk/model-registry.js";
import type { KittenTtsModelId } from "../../src/sdk/contracts.js";

interface ExpectedCase {
  id: string;
  inputIdsSha256: string;
  styleSha256: string;
  audio: { numSamples: number; nodeSampleTolerance: number; browserSampleTolerance: number };
}

interface ExpectedModel {
  id: KittenTtsModelId;
  repoId: string;
  revision: string;
  cases: ExpectedCase[];
}

interface ModelCase {
  id: string;
  text: string;
  voice: string;
  speed: number;
  clean_text: boolean;
}

function assertAudioSanity(label: string, audio: ReturnType<typeof summarizeAudio>): void {
  const scalarMetrics = {
    numSamples: audio.num_samples,
    min: audio.min,
    max: audio.max,
    mean: audio.mean,
    std: audio.std,
    rms: audio.rms,
  };
  for (const [metric, value] of Object.entries(scalarMetrics)) {
    if (!Number.isFinite(value)) throw new Error(`${label} ${metric} is not finite`);
  }
  if (audio.min >= -0.01 || audio.max <= 0.01) throw new Error(`${label} does not contain both audio polarities`);
  if (audio.min < -1.5 || audio.max > 1.5) throw new Error(`${label} amplitude exceeds the safety bound`);
  if (Math.abs(audio.mean) > 0.2) throw new Error(`${label} DC offset exceeds the safety bound`);
  if (audio.std < 0.01 || audio.std > 0.5) throw new Error(`${label} standard deviation is outside speech bounds`);
  if (audio.rms < 0.01 || audio.rms > 0.5) throw new Error(`${label} RMS is outside speech bounds`);
}

function sha256(bytes: ArrayBufferView): string {
  return createHash("sha256").update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

function inputIdsSha256(inputIds: readonly number[]): string {
  const bytes = Buffer.alloc(inputIds.length * 8);
  inputIds.forEach((value, index) => bytes.writeBigInt64LE(BigInt(value), index * 8));
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDefinition(expected: ExpectedModel, definition: KittenTtsModelDefinition): void {
  if (expected.repoId !== definition.repoId || expected.revision !== definition.revision) {
    throw new Error(`${expected.id} fixture does not match the model registry`);
  }
}

export async function verifyModelMatrix(): Promise<void> {
  const fixture = JSON.parse(await fs.readFile("fixtures/model-parity.json", "utf8")) as { models: ExpectedModel[] };
  const corpus = JSON.parse(await fs.readFile("fixtures/model-parity-corpus.json", "utf8")) as { cases: ModelCase[] };
  const corpusById = new Map(corpus.cases.map((testCase) => [testCase.id, testCase]));
  if (corpusById.size < 3) throw new Error("model parity corpus must contain at least three cases");
  const summaries = [];

  for (const expected of fixture.models) {
    const definition = KITTENTTS_MODELS[expected.id];
    assertDefinition(expected, definition);
    const started = performance.now();
    const runtime = await createNodeKittenTts({
      repoId: definition.repoId,
      revision: definition.revision,
      cacheDir: process.env.KITTENTTS_MATRIX_CACHE ?? path.resolve(".context", "model-matrix-cache"),
      integrity: {
        [definition.modelFilename]: definition.modelSha256,
        [definition.voicesFilename]: definition.voicesSha256,
      },
    });
    const initializedMs = performance.now() - started;
    try {
      const caseSummaries = [];
      for (const expectedCase of expected.cases) {
        const testCase = corpusById.get(expectedCase.id);
        if (!testCase) throw new Error(`${expected.id} references missing case '${expectedCase.id}'`);
        const inferenceStarted = performance.now();
        const result = await runtime.synthesize({
          text: testCase.text,
          voice: testCase.voice,
          speed: testCase.speed,
          cleanText: testCase.clean_text,
        });
        const inferenceMs = performance.now() - inferenceStarted;
        const chunk = result.chunks[0];
        const label = `${expected.id}:${expectedCase.id}`;
        if (!chunk || result.chunks.length !== 1) throw new Error(`${label} produced an unexpected chunk count`);
        if (inputIdsSha256(chunk.inputIds) !== expectedCase.inputIdsSha256) throw new Error(`${label} input IDs differ from Python`);
        if (sha256(chunk.style) !== expectedCase.styleSha256) throw new Error(`${label} voice style differs from Python`);
        const sampleDelta = result.audio.length - expectedCase.audio.numSamples;
        if (Math.abs(sampleDelta) > expectedCase.audio.nodeSampleTolerance) {
          throw new Error(`${label} sample count ${result.audio.length} differs from Python ${expectedCase.audio.numSamples} by ${sampleDelta} samples; tolerance is ${expectedCase.audio.nodeSampleTolerance}`);
        }
        if (!chunk.durations || chunk.durations.length !== chunk.inputIds.length) throw new Error(`${label} duration output is missing`);
        const actual = summarizeAudio(result.audio);
        assertAudioSanity(label, actual);
        if (inferenceMs > 120_000) throw new Error(`${label} exceeded the 120 second performance guardrail`);
        caseSummaries.push({
          id: expectedCase.id,
          inferenceMs: Math.round(inferenceMs),
          samples: result.audio.length,
          sampleDelta,
          sampleTolerance: expectedCase.audio.nodeSampleTolerance,
        });
      }
      if (initializedMs > 120_000) throw new Error(`${expected.id} initialization exceeded the 120 second performance guardrail`);
      summaries.push({
        id: expected.id,
        initializedMs: Math.round(initializedMs),
        cases: caseSummaries,
      });
    } finally {
      await runtime.release();
    }
  }
  console.log(JSON.stringify({ status: "pass", models: summaries }, null, 2));
}
