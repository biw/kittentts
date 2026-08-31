import * as ort from "/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs";
import {
  buildBrowserPhonemeInput,
  verifyManifestBrowserInputs,
} from "/web/browser-phonemizer.mjs";
import {
  buildBrowserPipelineFeeds,
  chunkMatchesFixture,
  loadBrowserVoices,
  verifyManifestBrowserPipeline,
} from "/web/browser-pipeline.mjs";
import { BrowserKittenTtsWorkerClient } from "/web/browser-worker-client.mjs";

const TRIM_SAMPLES = 5000;
const TOLERANCES = {
  min: 0.05,
  max: 0.05,
  mean: 5e-4,
  std: 5e-4,
  rms: 5e-4,
};

const statusEl = document.querySelector("#status");
const caseLabelEl = document.querySelector("#case-label");
const pipelineLabelEl = document.querySelector("#pipeline-label");
const transportLabelEl = document.querySelector("#transport-label");
const providerLabelEl = document.querySelector("#provider-label");
const resultEl = document.querySelector("#result");

function setStatus(label, tone = "neutral") {
  statusEl.textContent = label;
  statusEl.style.background =
    tone === "pass" ? "rgba(86, 144, 87, 0.18)" :
    tone === "fail" ? "rgba(168, 67, 51, 0.18)" :
    "rgba(255, 255, 255, 0.55)";
}

function summarizeAudio(audio) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  for (const value of audio) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / audio.length;
  let varianceSum = 0;
  for (const value of audio) {
    const delta = value - mean;
    varianceSum += delta * delta;
  }
  return {
    num_samples: audio.length,
    min,
    max,
    mean,
    std: Math.sqrt(varianceSum / audio.length),
    rms: Math.sqrt(sumSq / audio.length),
  };
}

function deltaStats(actual, expected) {
  return {
    min: Math.abs(actual.min - expected.min),
    max: Math.abs(actual.max - expected.max),
    mean: Math.abs(actual.mean - expected.mean),
    std: Math.abs(actual.std - expected.std),
    rms: Math.abs(actual.rms - expected.rms),
  };
}

function readFixtureCase(manifest) {
  const params = new URLSearchParams(window.location.search);
  const caseId = params.get("case");
  return manifest.cases.find((entry) => entry.id === caseId) ?? manifest.cases[0];
}

function readFixtureChunk(fixtureCase) {
  const params = new URLSearchParams(window.location.search);
  const chunkIndex = Number.parseInt(params.get("chunk") ?? "0", 10);
  return fixtureCase.chunks[Number.isFinite(chunkIndex) ? chunkIndex : 0] ?? fixtureCase.chunks[0];
}

function readPipelineMode() {
  const mode = new URLSearchParams(window.location.search).get("pipeline") ?? "fixture";
  if (mode === "fixture" || mode === "phonemizer-js" || mode === "full-js") {
    return mode;
  }
  throw new Error(`unsupported pipeline mode '${mode}'`);
}

function readExecutionMode() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("execution") ?? "auto";
  if (mode === "auto" || mode === "wasm") {
    return mode;
  }
  throw new Error(`unsupported execution mode '${mode}'`);
}

function readTransportMode() {
  const mode = new URLSearchParams(window.location.search).get("transport") ?? "main";
  if (mode === "main" || mode === "worker") {
    return mode;
  }
  throw new Error(`unsupported transport mode '${mode}'`);
}

function summarizeMismatch(preview) {
  return preview.slice(0, 16);
}

function buildCaseParityReport(fixtureCase, browserResult, { maxMismatches = 5 } = {}) {
  const report = {
    totalCases: 1,
    totalChunks: fixtureCase.chunks.length,
    cleanedTextExactCases: browserResult.cleanedText === fixtureCase.cleaned_text ? 1 : 0,
    chunkCountExactCases: browserResult.chunks.length === fixtureCase.chunks.length ? 1 : 0,
    exactChunks: 0,
    mismatches: [],
  };

  if (!report.cleanedTextExactCases) {
    report.mismatches.push({
      caseId: fixtureCase.id,
      field: "cleaned_text",
      expected: fixtureCase.cleaned_text,
      actual: browserResult.cleanedText,
    });
  }
  if (!report.chunkCountExactCases && report.mismatches.length < maxMismatches) {
    report.mismatches.push({
      caseId: fixtureCase.id,
      field: "chunk_count",
      expected: fixtureCase.chunks.length,
      actual: browserResult.chunks.length,
    });
  }

  const chunkCount = Math.max(fixtureCase.chunks.length, browserResult.chunks.length);
  for (let index = 0; index < chunkCount; index += 1) {
    const fixtureChunk = fixtureCase.chunks[index];
    const browserChunk = browserResult.chunks[index];
    if (fixtureChunk && browserChunk && chunkMatchesFixture(browserChunk, fixtureChunk)) {
      report.exactChunks += 1;
      continue;
    }
    if (report.mismatches.length < maxMismatches) {
      report.mismatches.push({
        caseId: fixtureCase.id,
        chunkIndex: index,
        field: "chunk",
        expectedText: fixtureChunk?.text ?? null,
        actualText: browserChunk?.text ?? null,
        expectedResolvedVoice: fixtureChunk?.resolved_voice ?? null,
        actualResolvedVoice: browserChunk?.resolvedVoice ?? null,
        expectedEffectiveSpeed: fixtureChunk?.effective_speed ?? null,
        actualEffectiveSpeed: browserChunk?.effectiveSpeed ?? null,
        expectedPhonemesRaw: fixtureChunk?.phonemes_raw ?? null,
        actualPhonemesRaw: browserChunk?.phonemesRaw ?? null,
        expectedInputIdsPreview: fixtureChunk?.input_ids ? summarizeMismatch(fixtureChunk.input_ids) : null,
        actualInputIdsPreview: browserChunk?.inputIds ? summarizeMismatch(browserChunk.inputIds) : null,
        expectedRefId: fixtureChunk?.ref_id ?? null,
        actualRefId: browserChunk?.refId ?? null,
      });
    }
  }

  return report;
}

async function createSessionWithFallback(modelUrl, executionMode) {
  const attempts = [];
  const providerSets =
    executionMode === "wasm"
      ? [["wasm"]]
      : navigator.gpu
        ? [["webgpu", "wasm"], ["wasm"]]
        : [["wasm"]];

  for (const executionProviders of providerSets) {
    try {
      const session = await ort.InferenceSession.create(modelUrl, { executionProviders });
      return { session, executionProviders };
    } catch (error) {
      attempts.push({
        executionProviders,
        message: error?.message ?? String(error),
      });
    }
  }

  throw new Error(JSON.stringify(attempts, null, 2));
}

async function main() {
  setStatus("running");
  ort.env.logLevel = "warning";
  const executionMode = readExecutionMode();
  const transportMode = readTransportMode();
  ort.env.wasm.numThreads =
    executionMode === "wasm"
      ? 1
      : self.crossOriginIsolated
        ? Math.min(4, navigator.hardwareConcurrency || 1)
        : 1;

  const manifest = await fetch("/.context/reference-fixtures/manifest.json").then((response) => {
    if (!response.ok) throw new Error(`failed to load manifest: ${response.status}`);
    return response.json();
  });

  const pipelineMode = readPipelineMode();
  const fixtureCase = readFixtureCase(manifest);
  const chunk = readFixtureChunk(fixtureCase);
  caseLabelEl.textContent = `case: ${fixtureCase.id} chunk ${chunk.index}`;
  pipelineLabelEl.textContent = `pipeline: ${pipelineMode} · execution: ${executionMode}`;
  transportLabelEl.textContent = `transport: ${transportMode}`;

  let feeds;
  let browserInput = null;
  let phonemizerReport = null;
  let fullPipelineReport = null;
  let browserPipeline = null;
  let executionProviders;
  let workerInit = null;
  let caseAudioStats = null;
  let caseAudioDeltas = null;
  let actual;

  if (transportMode === "worker") {
    if (pipelineMode !== "full-js") {
      throw new Error("worker transport currently supports only pipeline=full-js");
    }
    const client = await BrowserKittenTtsWorkerClient.create();
    try {
      workerInit = await client.init({
        manifestUrl: "/.context/reference-fixtures/manifest.json",
        executionMode,
      });
      executionProviders = workerInit.executionProviders;
      providerLabelEl.textContent = `providers: ${executionProviders.join(" -> ")}`;

      browserPipeline = await client.synthesize({
        text: fixtureCase.text,
        voice: fixtureCase.voice,
        speed: fixtureCase.speed,
        cleanText: fixtureCase.clean_text,
      });
      fullPipelineReport = buildCaseParityReport(fixtureCase, browserPipeline);
      if (
        fullPipelineReport.cleanedTextExactCases !== fullPipelineReport.totalCases ||
        fullPipelineReport.chunkCountExactCases !== fullPipelineReport.totalCases ||
        fullPipelineReport.exactChunks !== fullPipelineReport.totalChunks
      ) {
        throw new Error(`worker full pipeline parity failed\n${JSON.stringify(fullPipelineReport, null, 2)}`);
      }

      const browserChunk = browserPipeline.chunks[chunk.index];
      if (!browserChunk) {
        throw new Error(`missing worker pipeline chunk ${chunk.index} for ${fixtureCase.id}`);
      }
      browserInput = {
        phonemesRaw: browserChunk.phonemesRaw,
        inputIds: browserChunk.inputIds,
      };
      actual = browserChunk.audio;
      caseAudioStats = summarizeAudio(browserPipeline.audio);
      caseAudioDeltas = deltaStats(caseAudioStats, fixtureCase.audio);
      if (caseAudioStats.num_samples !== fixtureCase.audio.num_samples) {
        throw new Error(
          `worker case sample count mismatch: got ${caseAudioStats.num_samples}, expected ${fixtureCase.audio.num_samples}`,
        );
      }
      for (const [metric, tolerance] of Object.entries(TOLERANCES)) {
        if (caseAudioDeltas[metric] > tolerance) {
          throw new Error(`worker case ${metric} delta ${caseAudioDeltas[metric]} exceeds tolerance ${tolerance}`);
        }
      }
    } finally {
      await client.release();
    }
  } else {
    const modelUrl = `/.context/reference-fixtures/${manifest.model_asset_path}`;
    const sessionInfo = await createSessionWithFallback(modelUrl, executionMode);
    const session = sessionInfo.session;
    executionProviders = sessionInfo.executionProviders;
    providerLabelEl.textContent = `providers: ${executionProviders.join(" -> ")}`;

    if (pipelineMode === "phonemizer-js") {
      phonemizerReport = await verifyManifestBrowserInputs(manifest);
      if (
        phonemizerReport.phonemeExactChunks !== phonemizerReport.totalChunks ||
        phonemizerReport.inputIdExactChunks !== phonemizerReport.totalChunks
      ) {
        throw new Error(`browser phonemizer parity failed\n${JSON.stringify(phonemizerReport, null, 2)}`);
      }

      browserInput = await buildBrowserPhonemeInput(chunk.text);
      feeds = {
        input_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from(browserInput.inputIds.map((value) => BigInt(value))),
          [1, browserInput.inputIds.length],
        ),
        style: new ort.Tensor("float32", Float32Array.from(chunk.style.flat()), chunk.style_shape),
        speed: new ort.Tensor("float32", Float32Array.from(chunk.speed), [chunk.speed.length]),
      };
    } else if (pipelineMode === "full-js") {
      fullPipelineReport = await verifyManifestBrowserPipeline(manifest);
      if (
        fullPipelineReport.cleanedTextExactCases !== fullPipelineReport.totalCases ||
        fullPipelineReport.chunkCountExactCases !== fullPipelineReport.totalCases ||
        fullPipelineReport.exactChunks !== fullPipelineReport.totalChunks
      ) {
        throw new Error(`browser full pipeline parity failed\n${JSON.stringify(fullPipelineReport, null, 2)}`);
      }

      const voices = await loadBrowserVoices(manifest);
      browserPipeline = await buildBrowserPipelineFeeds({
        text: fixtureCase.text,
        voice: fixtureCase.voice,
        speed: fixtureCase.speed,
        cleanText: fixtureCase.clean_text,
        manifest,
        voices,
      });
      const browserChunk = browserPipeline.chunks[chunk.index];
      if (!browserChunk) {
        throw new Error(`missing browser pipeline chunk ${chunk.index} for ${fixtureCase.id}`);
      }
      browserInput = {
        phonemesRaw: browserChunk.phonemesRaw,
        inputIds: browserChunk.inputIds,
      };
      feeds = {
        input_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from(browserChunk.inputIds.map((value) => BigInt(value))),
          [1, browserChunk.inputIds.length],
        ),
        style: new ort.Tensor("float32", browserChunk.style, browserChunk.styleShape),
        speed: new ort.Tensor("float32", Float32Array.from([browserChunk.effectiveSpeed]), [1]),
      };
    } else {
      feeds = {
        input_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from(chunk.input_ids.map((value) => BigInt(value))),
          [1, chunk.input_ids.length],
        ),
        style: new ort.Tensor("float32", Float32Array.from(chunk.style.flat()), chunk.style_shape),
        speed: new ort.Tensor("float32", Float32Array.from(chunk.speed), [chunk.speed.length]),
      };
    }

    const outputs = await session.run(feeds);
    const firstOutput = outputs[session.outputNames[0]];
    if (!firstOutput) {
      throw new Error("model returned no output");
    }
    actual = firstOutput.data.slice(0, firstOutput.data.length - TRIM_SAMPLES);
  }

  const actualStats = summarizeAudio(actual);
  const expectedStats = chunk.audio;
  const deltas = deltaStats(actualStats, expectedStats);

  if (actualStats.num_samples !== expectedStats.num_samples) {
    throw new Error(`sample count mismatch: got ${actualStats.num_samples}, expected ${expectedStats.num_samples}`);
  }
  for (const [metric, tolerance] of Object.entries(TOLERANCES)) {
    if (deltas[metric] > tolerance) {
      throw new Error(`${metric} delta ${deltas[metric]} exceeds tolerance ${tolerance}`);
    }
  }

  const payload = {
    pipelineMode,
    executionMode,
    transportMode,
    caseId: fixtureCase.id,
    chunkIndex: chunk.index,
    executionProviders,
    workerInit,
    expectedCleanedText: fixtureCase.cleaned_text,
    browserCleanedText: browserPipeline?.cleanedText ?? fixtureCase.cleaned_text,
    chunkText: chunk.text,
    expectedResolvedVoice: chunk.resolved_voice,
    browserResolvedVoice: browserPipeline?.chunks[chunk.index]?.resolvedVoice ?? chunk.resolved_voice,
    expectedEffectiveSpeed: chunk.effective_speed,
    browserEffectiveSpeed: browserPipeline?.chunks[chunk.index]?.effectiveSpeed ?? chunk.effective_speed,
    expectedPhonemesRaw: chunk.phonemes_raw,
    browserPhonemesRaw: browserInput?.phonemesRaw ?? chunk.phonemes_raw,
    expectedInputIdsLength: chunk.input_ids.length,
    browserInputIdsLength: browserInput?.inputIds.length ?? chunk.input_ids.length,
    phonemizerReport,
    fullPipelineReport,
    caseAudioStats,
    caseAudioExpected: fixtureCase.audio,
    caseAudioDeltas,
    actual: actualStats,
    expected: expectedStats,
    deltas,
  };
  resultEl.textContent = JSON.stringify(payload, null, 2);
  setStatus("pass", "pass");
  document.body.dataset.status = "pass";
}

main().catch((error) => {
  resultEl.textContent = error.stack || String(error);
  providerLabelEl.textContent = "providers: failed";
  setStatus("fail", "fail");
  document.body.dataset.status = "fail";
});
