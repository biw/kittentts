import {
  KittenTTS,
  runtimeConfigFromManifest,
} from "/node_modules/@biwills/kittentts/dist/sdk/browser-entry.js";

const params = new URLSearchParams(window.location.search);
const transport = params.get("transport") === "worker" ? "worker" : "main";
const executionMode = params.get("execution") === "auto" ? "auto" : "wasm";
const statusChip = document.querySelector("#status-chip");
const resultJson = document.querySelector("#result-json");
const ortModuleUrls = {
  wasm: "/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs",
  webgpu: "/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs",
};

function report(status, result) {
  statusChip.textContent = status;
  resultJson.textContent = JSON.stringify(result, null, 2);
}

function audioSignature(audio, bins = 32) {
  const signature = { rms: [], deltaRms: [], zeroCrossingRate: [] };
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin * audio.length) / bins);
    const end = Math.floor(((bin + 1) * audio.length) / bins);
    let sumSquares = 0;
    let deltaSquares = 0;
    let crossings = 0;
    for (let index = start; index < end; index += 1) {
      const value = audio[index] ?? 0;
      sumSquares += value * value;
      if (index > start) {
        const previous = audio[index - 1] ?? 0;
        const delta = value - previous;
        deltaSquares += delta * delta;
        if ((previous < 0) !== (value < 0)) crossings += 1;
      }
    }
    const count = Math.max(1, end - start);
    const deltaCount = Math.max(1, count - 1);
    signature.rms.push(Math.sqrt(sumSquares / count));
    signature.deltaRms.push(Math.sqrt(deltaSquares / deltaCount));
    signature.zeroCrossingRate.push(crossings / deltaCount);
  }
  return signature;
}

function meanAbsoluteDelta(actual, expected) {
  return actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length;
}

async function run() {
  const manifest = await fetch("/fixtures/manifest.json").then((response) => response.json());
  const init = {
    config: runtimeConfigFromManifest(manifest),
    modelUrl: "/fixtures/model.onnx",
    voicesUrl: "/fixtures/voices.npz",
    executionMode,
    ortModuleUrls,
  };
  const runtime = await KittenTTS.create({
    ...init,
    transport: transport === "worker" ? "worker" : "direct",
  });
  try {
    let checkedChunks = 0;
    let mp3Bytes = 0;
    let executionProviders = [];
    const maxSignatureDeltas = { rms: 0, deltaRms: 0, zeroCrossingRate: 0 };
    for (const fixtureCase of manifest.cases) {
      const result = await runtime.generate(fixtureCase.text, {
        voice: fixtureCase.voice,
        speed: fixtureCase.speed,
        cleanText: fixtureCase.clean_text,
      });
      executionProviders = result.executionProviders;
      if (mp3Bytes === 0) {
        const mp3 = await result.mp3Data({ bitrate: 64 });
        if (mp3.length < 100) throw new Error("packed browser MP3 encoder returned no data");
        mp3Bytes = mp3.length;
      }
      if (result.sampleRate !== manifest.sample_rate || result.cleanedText !== fixtureCase.cleaned_text || result.chunks.length !== fixtureCase.chunks.length || result.audio.length !== fixtureCase.audio.num_samples) {
        throw new Error(`packed browser parity mismatch for ${fixtureCase.id}`);
      }
      for (let index = 0; index < result.chunks.length; index += 1) {
        const actual = result.chunks[index];
        const expected = fixtureCase.chunks[index];
        if (actual.text !== expected.text || actual.phonemesRaw !== expected.phonemes_raw || actual.audio.length !== expected.audio.num_samples || JSON.stringify(actual.inputIds) !== JSON.stringify(expected.input_ids)) {
          throw new Error(`packed browser chunk mismatch for ${fixtureCase.id}:${index}`);
        }
        const signature = audioSignature(actual.audio, expected.audio.signature.bins);
        const deltas = {
          rms: meanAbsoluteDelta(signature.rms, expected.audio.signature.rms),
          deltaRms: meanAbsoluteDelta(signature.deltaRms, expected.audio.signature.delta_rms),
          zeroCrossingRate: meanAbsoluteDelta(signature.zeroCrossingRate, expected.audio.signature.zero_crossing_rate),
        };
        const tolerances = { rms: 0.003, deltaRms: 0.001, zeroCrossingRate: 0.01 };
        for (const key of Object.keys(deltas)) {
          maxSignatureDeltas[key] = Math.max(maxSignatureDeltas[key], deltas[key]);
          if (deltas[key] > tolerances[key]) {
            throw new Error(`packed browser audio signature ${key} mismatch for ${fixtureCase.id}:${index}`);
          }
        }
        checkedChunks += 1;
      }
    }
    report("pass", {
      transport,
      capabilities: runtime.capabilities(),
      executionProviders,
      checkedCases: manifest.cases.length,
      checkedChunks,
      mp3Bytes,
      maxSignatureDeltas,
    });
  } finally {
    await runtime.release();
    await runtime.release();
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  report("fail", { transport, error: message });
});
