import {
  AUDIO_SIGNATURE_TOLERANCES,
  AUDIO_TOLERANCES,
  CORPUS_AUDIO_TOLERANCES,
  audioSignatureDeltas,
  audioDeltas,
  summarizeAudio,
  type FixtureManifest,
} from "../../src/core/phoneme-feeds.js";
import { chunkMatchesFixture } from "../../src/core/pipeline.js";
import { runtimeConfigFromManifest } from "../../src/core/runtime-config.js";
import { createNodeKittenTts } from "../../src/node/runtime.js";

// The Python reference reruns inference while generating each fixture, so its
// waveform statistics vary slightly across otherwise identical Node executions.
const NODE_RUNTIME_AUDIO_TOLERANCES = {
  mean: AUDIO_TOLERANCES.mean,
  std: 7.5e-4,
  rms: 7.5e-4,
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function verifyNodeRuntime(
  options: { listeningDir?: string } = {},
): Promise<void> {
  const listeningDir = options.listeningDir
    ? path.resolve(options.listeningDir)
    : process.env.KITTENTTS_LISTENING_DIR
      ? path.resolve(process.env.KITTENTTS_LISTENING_DIR)
      : undefined;
  if (listeningDir) {
    await fs.mkdir(listeningDir, { recursive: true });
  }
  const runtime = await createNodeKittenTts();
  const manifest = runtime.manifest as FixtureManifest | undefined;
  assert(manifest, "runtime manifest missing for fixture-backed verification");

  let checkedCases = 0;
  let checkedChunks = 0;
  const observedMaxChunkDeltas: ReturnType<typeof audioDeltas> = {
    min: 0,
    max: 0,
    mean: 0,
    std: 0,
    rms: 0,
  };
  const observedMaxSignatureDeltas: ReturnType<typeof audioSignatureDeltas> = {
    rms: 0,
    deltaRms: 0,
    zeroCrossingRate: 0,
  };
  let firstCaseSummary:
    | {
        caseId: string;
        firstChunkDeltas: ReturnType<typeof audioDeltas>;
      }
    | undefined;

  try {
    for (const fixtureCase of manifest.cases) {
      const result = await runtime.synthesize({
        text: fixtureCase.text,
        voice: fixtureCase.voice,
        speed: fixtureCase.speed,
        cleanText: fixtureCase.clean_text,
      });

      assert(result.cleanedText === fixtureCase.cleaned_text, `cleaned text mismatch for ${fixtureCase.id}`);
      assert(result.chunks.length === fixtureCase.chunks.length, `chunk count mismatch for ${fixtureCase.id}`);
      assert(result.sampleRate === manifest.sample_rate, `sample rate mismatch for ${fixtureCase.id}`);

      for (let index = 0; index < result.chunks.length; index += 1) {
        const resultChunk = result.chunks[index];
        const fixtureChunk = fixtureCase.chunks[index];
        assert(fixtureChunk, `missing fixture chunk ${index} for ${fixtureCase.id}`);
        if (!chunkMatchesFixture(resultChunk, fixtureChunk)) {
          throw new Error(`runtime chunk mismatch for ${fixtureCase.id} chunk ${index}`);
        }
        const actualChunkAudio = summarizeAudio(resultChunk.audio);
        assert(
          Number.isFinite(actualChunkAudio.min) && Number.isFinite(actualChunkAudio.max) &&
            actualChunkAudio.min >= -2 && actualChunkAudio.max <= 2,
          `unsafe or non-finite audio amplitude for ${fixtureCase.id} chunk ${index}`,
        );
        const chunkDeltas = audioDeltas(actualChunkAudio, fixtureChunk.audio);
        const signatureDeltas = audioSignatureDeltas(actualChunkAudio.signature, fixtureChunk.audio.signature);
        assert(
          actualChunkAudio.num_samples === fixtureChunk.audio.num_samples,
          `sample count mismatch for ${fixtureCase.id} chunk ${index}`,
        );
        for (const metric of Object.keys(observedMaxChunkDeltas) as Array<keyof typeof observedMaxChunkDeltas>) {
          observedMaxChunkDeltas[metric] = Math.max(observedMaxChunkDeltas[metric], chunkDeltas[metric]);
        }
        for (const [metric, tolerance] of Object.entries(CORPUS_AUDIO_TOLERANCES)) {
          const delta = chunkDeltas[metric as keyof typeof chunkDeltas];
          if (delta > tolerance) {
            throw new Error(
              `${fixtureCase.id} chunk ${index} ${metric} delta ${delta} exceeds corpus tolerance ${tolerance}`,
            );
          }
        }
        for (const [metric, tolerance] of Object.entries(AUDIO_SIGNATURE_TOLERANCES)) {
          const key = metric as keyof typeof signatureDeltas;
          const delta = signatureDeltas[key];
          observedMaxSignatureDeltas[key] = Math.max(observedMaxSignatureDeltas[key], delta);
          if (delta > tolerance) {
            throw new Error(
              `${fixtureCase.id} chunk ${index} audio signature ${metric} delta ${delta} exceeds tolerance ${tolerance}`,
            );
          }
        }
        checkedChunks += 1;
      }

      assert(result.audio.length === fixtureCase.audio.num_samples, `case audio sample count mismatch for ${fixtureCase.id}`);
      if (listeningDir) {
        await fs.writeFile(
          path.join(listeningDir, `${fixtureCase.id}.wav`),
          encodeWav(result.audio, { sampleRate: result.sampleRate }),
        );
      }

      if (!firstCaseSummary) {
        const firstChunkFixture = fixtureCase.chunks[0];
        const firstChunkResult = result.chunks[0];
        assert(firstChunkFixture, `missing first fixture chunk for ${fixtureCase.id}`);
        assert(firstChunkResult, `missing first runtime chunk for ${fixtureCase.id}`);
        const firstChunkDeltas = audioDeltas(summarizeAudio(firstChunkResult.audio), firstChunkFixture.audio);
        for (const [metric, tolerance] of Object.entries(NODE_RUNTIME_AUDIO_TOLERANCES)) {
          const delta = firstChunkDeltas[metric as keyof typeof firstChunkDeltas];
          if (delta > tolerance) {
            throw new Error(
              `${fixtureCase.id} representative chunk ${metric} delta ${delta} exceeds tolerance ${tolerance}`,
            );
          }
        }
        firstCaseSummary = {
          caseId: fixtureCase.id,
          firstChunkDeltas,
        };
      }
      checkedCases += 1;
    }
  } finally {
    await runtime.release();
  }

  const configRuntime = await createNodeKittenTts({
    config: runtimeConfigFromManifest(manifest),
    modelPath: runtime.modelPath,
    voicesPath: runtime.voicesPath,
  });
  try {
    const firstCase = manifest.cases[0];
    assert(firstCase, "missing first fixture case");
    const result = await configRuntime.synthesize({
      text: firstCase.text,
      voice: firstCase.voice,
      speed: firstCase.speed,
      cleanText: firstCase.clean_text,
    });
    assert(result.sampleRate === manifest.sample_rate, "config-backed runtime sample rate mismatch");
    assert(result.cleanedText === firstCase.cleaned_text, "config-backed runtime cleaned text mismatch");
    assert(result.chunks.length === firstCase.chunks.length, "config-backed runtime chunk count mismatch");
    for (let index = 0; index < result.chunks.length; index += 1) {
      const resultChunk = result.chunks[index];
      const fixtureChunk = firstCase.chunks[index];
      assert(fixtureChunk, `missing config-backed fixture chunk ${index}`);
      if (!chunkMatchesFixture(resultChunk, fixtureChunk)) {
        throw new Error(`config-backed runtime chunk mismatch for ${firstCase.id} chunk ${index}`);
      }
    }
  } finally {
    await configRuntime.release();
  }

  console.log(
    JSON.stringify(
      {
        checkedCases,
        checkedChunks,
        executionProviders: [...runtime.executionProviders],
        configPathVerified: true,
        listeningSamples: listeningDir ? manifest.cases.length : 0,
        observedMaxChunkDeltas,
        observedMaxSignatureDeltas,
        ...firstCaseSummary,
      },
      null,
      2,
    ),
  );
}
import fs from "node:fs/promises";
import path from "node:path";
import { encodeWav } from "../../src/audio/index.js";
