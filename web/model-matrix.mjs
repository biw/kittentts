import { browserAssetCacheInfo, KittenTTS } from "/dist/sdk/browser-entry.js";

const statusChip = document.querySelector("#status-chip");
const resultJson = document.querySelector("#result-json");
const params = new URLSearchParams(location.search);
const executionMode = params.get("execution") === "webgpu" ? "webgpu" : "wasm";
const ortModuleUrls = {
  wasm: "/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs",
  webgpu: "/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs",
};

function report(status, result) {
  statusChip.textContent = status;
  resultJson.textContent = JSON.stringify(result, null, 2);
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function inputIdsSha256(inputIds) {
  const bytes = new ArrayBuffer(inputIds.length * 8);
  const view = new DataView(bytes);
  inputIds.forEach((value, index) => view.setBigInt64(index * 8, BigInt(value), true));
  return sha256(bytes);
}

function summarize(audio) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSquares = 0;
  for (const value of audio) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    sumSquares += value * value;
  }
  const mean = sum / audio.length;
  return {
    numSamples: audio.length,
    min,
    max,
    mean,
    std: Math.sqrt(Math.max(0, sumSquares / audio.length - mean * mean)),
    rms: Math.sqrt(sumSquares / audio.length),
  };
}

function assertAudioSanity(label, audio) {
  for (const [metric, value] of Object.entries(audio)) {
    if (!Number.isFinite(value)) throw new Error(`${label} ${metric} is not finite`);
  }
  if (audio.min >= -0.01 || audio.max <= 0.01) throw new Error(`${label} does not contain both audio polarities`);
  if (audio.min < -1.5 || audio.max > 1.5) throw new Error(`${label} amplitude exceeds the safety bound`);
  if (Math.abs(audio.mean) > 0.2) throw new Error(`${label} DC offset exceeds the safety bound`);
  if (audio.std < 0.01 || audio.std > 0.5) throw new Error(`${label} standard deviation is outside speech bounds`);
  if (audio.rms < 0.01 || audio.rms > 0.5) throw new Error(`${label} RMS is outside speech bounds`);
}

async function run() {
  const [fixture, corpus] = await Promise.all([
    fetch("/fixtures/model-parity.json").then((response) => response.json()),
    fetch("/fixtures/model-parity-corpus.json").then((response) => response.json()),
  ]);
  const corpusById = new Map(corpus.cases.map((testCase) => [testCase.id, testCase]));
  if (corpusById.size < 3) throw new Error("model parity corpus must contain at least three cases");
  const summaries = [];
  for (const expected of fixture.models) {
    report("running", { model: expected.id, completed: summaries });
    const initializedAt = performance.now();
    const tts = await KittenTTS.create({
      model: expected.id,
      transport: "direct",
      executionMode,
      ortModuleUrls,
      repoBaseUrl: `${location.origin}/`,
    });
    const initializedMs = performance.now() - initializedAt;
    try {
      const caseSummaries = [];
      for (const expectedCase of expected.cases) {
        const testCase = corpusById.get(expectedCase.id);
        if (!testCase) throw new Error(`${expected.id} references missing case '${expectedCase.id}'`);
        const inferenceAt = performance.now();
        const result = await tts.generate(testCase.text, {
          voice: testCase.voice,
          speed: testCase.speed,
          cleanText: testCase.clean_text,
        });
        const inferenceMs = performance.now() - inferenceAt;
        const chunk = result.chunks[0];
        const label = `${expected.id}:${expectedCase.id}`;
        if (!chunk || result.chunks.length !== 1) throw new Error(`${label} chunk count mismatch`);
        if (await inputIdsSha256(chunk.inputIds) !== expectedCase.inputIdsSha256) throw new Error(`${label} input IDs differ from Python`);
        if (await sha256(chunk.style.slice().buffer) !== expectedCase.styleSha256) throw new Error(`${label} style differs from Python`);
        const sampleDelta = result.audio.length - expectedCase.audio.numSamples;
        if (Math.abs(sampleDelta) > expectedCase.audio.browserSampleTolerance) {
          throw new Error(`${label} sample count ${result.audio.length} differs from Python ${expectedCase.audio.numSamples} by ${sampleDelta} samples; tolerance is ${expectedCase.audio.browserSampleTolerance}`);
        }
        if (!chunk.durations || chunk.durations.length !== chunk.inputIds.length) throw new Error(`${label} duration output missing`);
        const actual = summarize(result.audio);
        assertAudioSanity(label, actual);
        caseSummaries.push({
          id: expectedCase.id,
          inferenceMs: Math.round(inferenceMs),
          samples: result.audio.length,
          sampleDelta,
          sampleTolerance: expectedCase.audio.browserSampleTolerance,
        });
      }
      summaries.push({
        id: expected.id,
        initializedMs: Math.round(initializedMs),
        cases: caseSummaries,
      });
    } finally {
      await tts.dispose();
    }
  }
  const offline = await KittenTTS.create({
    model: "nano",
    transport: "direct",
    executionMode,
    ortModuleUrls,
    repoBaseUrl: `${location.origin}/`,
    fetchImpl: async () => { throw new Error("asset network access attempted during warm-cache startup"); },
  });
  try {
    const result = await offline.generate("Offline cache verification.", { voice: "Bella" });
    if (result.audio.length === 0) throw new Error("offline cache verification produced no audio");
  } finally {
    await offline.dispose();
  }
  const cache = await browserAssetCacheInfo();
  if (!cache.available || cache.entries.length < 12) throw new Error("browser asset cache is incomplete");
  report("pass", { executionMode, models: summaries, offlineCache: true, cacheEntries: cache.entries.length });
}

run().catch((error) => {
  console.error(error);
  report("fail", { error: error instanceof Error ? error.message : String(error) });
});
