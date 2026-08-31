import {
  buildBrowserPipelineFeeds,
  loadBrowserVoices,
  resolveBrowserAssetUrl,
} from "/web/browser-pipeline.mjs";

const TRIM_SAMPLES = 5000;
const ortModuleCache = new Map();

function trimModelAudio(audio) {
  return audio.slice(0, audio.length - TRIM_SAMPLES);
}

function concatenateAudioSegments(segments) {
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const segment of segments) {
    output.set(segment, offset);
    offset += segment.length;
  }
  return output;
}

async function loadOrtModule(executionMode) {
  const key = executionMode === "wasm" ? "wasm" : "auto";
  if (!ortModuleCache.has(key)) {
    ortModuleCache.set(
      key,
      key === "wasm"
        ? import("/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs")
        : import("/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs"),
    );
  }
  return ortModuleCache.get(key);
}

async function createSessionWithFallback(ort, modelUrl, executionMode) {
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

async function loadManifest(manifestUrl) {
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`failed to load manifest: ${response.status}`);
  }
  return response.json();
}

async function runChunk(ort, session, chunk) {
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
  if (!firstOutput) {
    throw new Error("model returned no output");
  }
  return trimModelAudio(firstOutput.data);
}

export class BrowserKittenTts {
  static async create({
    manifestUrl = "/.context/reference-fixtures/manifest.json",
    manifest,
    modelUrl,
    voicesUrl,
    executionMode = "auto",
    logLevel = "warning",
    numThreads,
    onProgress,
  } = {}) {
    const normalizedManifestUrl = new URL(manifestUrl, self.location.href).toString();
    const loadedManifest = manifest ?? (await loadManifest(normalizedManifestUrl));
    onProgress?.("manifest-loaded");
    if (!loadedManifest.model_asset_path && !modelUrl) {
      throw new Error("model asset path missing from manifest");
    }
    if (!loadedManifest.voices_asset_path && !voicesUrl) {
      throw new Error("voices asset path missing from manifest");
    }

    const ort = await loadOrtModule(executionMode);
    onProgress?.("ort-loaded");
    ort.env.logLevel = logLevel;
    ort.env.wasm.numThreads =
      numThreads ??
      (executionMode === "wasm"
        ? 1
        : self.crossOriginIsolated
          ? Math.min(4, navigator.hardwareConcurrency || 1)
          : 1);

    const resolvedModelUrl =
      modelUrl ??
      resolveBrowserAssetUrl(loadedManifest.model_asset_path, { assetBaseUrl: normalizedManifestUrl });
    const voicesPromise = loadBrowserVoices(loadedManifest, {
      voicesUrl,
      assetBaseUrl: normalizedManifestUrl,
    }).then((voices) => {
      onProgress?.("voices-loaded");
      return voices;
    });
    const sessionPromise = createSessionWithFallback(ort, resolvedModelUrl, executionMode).then((sessionInfo) => {
      onProgress?.("session-created");
      return sessionInfo;
    });
    const [voices, sessionInfo] = await Promise.all([voicesPromise, sessionPromise]);
    onProgress?.("runtime-ready");

    return new BrowserKittenTts({
      ort,
      manifest: loadedManifest,
      session: sessionInfo.session,
      executionProviders: sessionInfo.executionProviders,
      voices,
      executionMode,
      manifestUrl: normalizedManifestUrl,
      modelUrl: resolvedModelUrl,
      voicesUrl:
        voicesUrl ??
        resolveBrowserAssetUrl(loadedManifest.voices_asset_path, { assetBaseUrl: normalizedManifestUrl }),
    });
  }

  constructor({ ort, manifest, manifestUrl, modelUrl, voicesUrl, session, executionProviders, voices, executionMode }) {
    this.ort = ort;
    this.manifest = manifest;
    this.manifestUrl = manifestUrl;
    this.modelUrl = modelUrl;
    this.voicesUrl = voicesUrl;
    this.session = session;
    this.executionProviders = executionProviders;
    this.voices = voices;
    this.executionMode = executionMode;
    this.disposed = false;
  }

  async synthesize({ text, voice, speed = 1, cleanText = true } = {}) {
    if (this.disposed) {
      throw new Error("browser runtime has been released");
    }
    const pipeline = await buildBrowserPipelineFeeds({
      text,
      voice,
      speed,
      cleanText,
      manifest: this.manifest,
      voices: this.voices,
    });

    const chunks = [];
    for (const chunk of pipeline.chunks) {
      const audio = await runChunk(this.ort, this.session, chunk);
      chunks.push({
        ...chunk,
        audio,
      });
    }

    return {
      sampleRate: this.manifest.sample_rate,
      executionProviders: [...this.executionProviders],
      executionMode: this.executionMode,
      cleanedText: pipeline.cleanedText,
      chunks,
      audio: concatenateAudioSegments(chunks.map((chunk) => chunk.audio)),
    };
  }

  async release() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.session.release();
  }
}

export async function createBrowserKittenTts(options) {
  return BrowserKittenTts.create(options);
}
