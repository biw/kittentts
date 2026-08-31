import type * as OrtWeb from "onnxruntime-web";
import type { FixtureManifest } from "../core/phoneme-feeds.js";
import { PhonemizerJsPhonemizer } from "../core/phonemizer.js";
import { buildPipelineFeeds, type PipelineChunkFeeds } from "../core/pipeline.js";
import {
  runtimeConfigFromManifest,
  type KittenTtsRuntimeConfig,
} from "../core/runtime-config.js";
import {
  buildKittenTtsRepoFileUrl,
  normalizeKittenTtsRepoReference,
  resolveKittenTtsRepoAssetsFromConfig,
  type FetchLike,
  type KittenTtsRepoReference,
} from "../core/repo-assets.js";
import { loadVoicesNpz, type VoicesNpz } from "../core/voices-npz.js";
import { fetchBrowserAsset } from "./asset-cache.js";
import { fetchWithRetry } from "../core/fetch-retry.js";

export interface BrowserOrtModuleUrls {
  wasm?: string;
  webgpu?: string;
}

export interface BrowserKittenTtsOptions {
  manifestUrl?: string;
  manifest?: FixtureManifest;
  config?: KittenTtsRuntimeConfig;
  repoId?: string;
  revision?: string;
  repoBaseUrl?: string;
  configFilename?: string;
  modelUrl?: string;
  voicesUrl?: string;
  fetchImpl?: FetchLike;
  executionMode?: "auto" | "wasm" | "webgpu";
  ortModuleLoader?: (executionMode: "auto" | "wasm" | "webgpu") => Promise<typeof OrtWeb>;
  ortModuleUrls?: BrowserOrtModuleUrls;
  logLevel?: OrtWeb.Env["logLevel"];
  numThreads?: number;
  cacheName?: string;
  forceDownload?: boolean;
  retries?: number;
  integrity?: Record<string, string>;
  signal?: AbortSignal;
  onDownloadProgress?: (asset: string, loadedBytes: number, totalBytes?: number) => void;
  onProgress?: (phase: string) => void;
}

export interface BrowserSynthesisRequest {
  text: string;
  voice: string;
  speed?: number;
  cleanText?: boolean;
  signal?: AbortSignal;
}

export interface BrowserSynthesisChunk extends PipelineChunkFeeds {
  audio: Float32Array;
  durations?: number[];
}

export interface BrowserSynthesisResult {
  sampleRate: number;
  executionProviders: string[];
  executionMode: "auto" | "wasm" | "webgpu";
  cleanedText: string;
  chunks: BrowserSynthesisChunk[];
  audio: Float32Array;
}

interface BrowserKittenTtsState {
  ort: typeof OrtWeb;
  manifest?: FixtureManifest;
  manifestUrl?: string;
  repo?: KittenTtsRepoReference;
  config: KittenTtsRuntimeConfig;
  modelUrl: string;
  voicesUrl: string;
  session: OrtWeb.InferenceSession;
  executionProviders: string[];
  voices: VoicesNpz;
  executionMode: "auto" | "wasm" | "webgpu";
  numThreads: number;
}

const TRIM_SAMPLES = 5000;
const ortModuleCache = new Map<string, Promise<typeof OrtWeb>>();

function trimModelAudio(audio: Float32Array): Float32Array {
  return audio.slice(0, audio.length - TRIM_SAMPLES);
}

async function hasWebGpuSupport(): Promise<boolean> {
  const browserNavigator = navigator as Navigator & {
    gpu?: { requestAdapter?: () => Promise<unknown> };
  };
  try {
    return (await browserNavigator.gpu?.requestAdapter?.()) != null;
  } catch {
    return false;
  }
}

function concatenateAudioSegments(segments: readonly Float32Array[]): Float32Array {
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const segment of segments) {
    output.set(segment, offset);
    offset += segment.length;
  }
  return output;
}

async function loadOrtModule(
  executionMode: "auto" | "wasm" | "webgpu",
  ortModuleUrls?: BrowserOrtModuleUrls,
): Promise<typeof OrtWeb> {
  const cacheKey = JSON.stringify({
    executionMode,
    wasm: ortModuleUrls?.wasm ?? null,
    webgpu: ortModuleUrls?.webgpu ?? null,
  });
  if (!ortModuleCache.has(cacheKey)) {
    const moduleSpecifier =
      executionMode === "wasm"
        ? (ortModuleUrls?.wasm ?? "onnxruntime-web/wasm")
        : (ortModuleUrls?.webgpu ?? "onnxruntime-web/webgpu");
    ortModuleCache.set(
      cacheKey,
      import(moduleSpecifier),
    );
  }
  return ortModuleCache.get(cacheKey)!;
}

async function createSessionWithFallback(
  ort: typeof OrtWeb,
  model: Uint8Array,
  executionMode: "auto" | "wasm" | "webgpu",
): Promise<{ session: OrtWeb.InferenceSession; executionProviders: string[] }> {
  const attempts: Array<{ executionProviders: string[]; message: string }> = [];
  const providerSets =
    executionMode === "wasm"
      ? [["wasm"]]
      : executionMode === "webgpu"
        ? (await hasWebGpuSupport()) ? [["webgpu"]] : []
      : (await hasWebGpuSupport())
        ? [["webgpu", "wasm"], ["wasm"]]
        : [["wasm"]];

  for (const executionProviders of providerSets) {
    try {
      const session = await ort.InferenceSession.create(model, { executionProviders });
      return { session, executionProviders: [...executionProviders] };
    } catch (error) {
      attempts.push({
        executionProviders: [...executionProviders],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (executionMode === "webgpu" && providerSets.length === 0) {
    throw new Error("WebGPU was requested but no GPU adapter is available");
  }
  throw new Error(JSON.stringify(attempts, null, 2));
}

async function loadManifest(manifestUrl: string, options: BrowserKittenTtsOptions): Promise<FixtureManifest> {
  const response = await fetchWithRetry(manifestUrl, options);
  if (!response.ok) {
    throw new Error(`failed to load manifest: ${response.status}`);
  }
  return (await response.json()) as FixtureManifest;
}

function resolveAssetUrl(assetPath: string, manifestUrl: string): string {
  return new URL(assetPath, manifestUrl).toString();
}

function assetFilename(assetUrl: string, fallback: string): string {
  return new URL(assetUrl, self.location.href).pathname.split("/").at(-1) || fallback;
}

async function loadVoices(
  manifest: FixtureManifest | undefined,
  { manifestUrl, voicesUrl, options }: { manifestUrl?: string; voicesUrl?: string; options: BrowserKittenTtsOptions },
): Promise<{ voices: VoicesNpz; resolvedVoicesUrl: string }> {
  const resolvedVoicesUrl =
    voicesUrl ??
    (manifest?.voices_asset_path && manifestUrl ? resolveAssetUrl(manifest.voices_asset_path, manifestUrl) : undefined);
  if (!resolvedVoicesUrl) {
    throw new Error("voicesUrl is required when no manifest-backed asset path is available");
  }

  const filename = assetFilename(resolvedVoicesUrl, "voices.npz");
  const bytes = await fetchBrowserAsset(resolvedVoicesUrl, {
    ...options,
    expectedSha256: options.integrity?.[filename],
    onProgress: (loaded, total) => options.onDownloadProgress?.(filename, loaded, total),
  });
  const voices = loadVoicesNpz(bytes);
  return { voices, resolvedVoicesUrl };
}

async function runChunk(
  ort: typeof OrtWeb,
  session: OrtWeb.InferenceSession,
  chunk: PipelineChunkFeeds,
): Promise<{ audio: Float32Array; durations?: number[] }> {
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
  if (!firstOutput || !(firstOutput.data instanceof Float32Array)) {
    throw new Error("model returned no Float32Array output");
  }
  const durationOutput = outputs.duration;
  const durations = durationOutput && (durationOutput.data instanceof BigInt64Array || durationOutput.data instanceof BigUint64Array)
    ? Array.from(durationOutput.data, Number)
    : undefined;
  return { audio: trimModelAudio(firstOutput.data), durations };
}

export class BrowserKittenTts {
  readonly #state: BrowserKittenTtsState;
  readonly #phonemizer = new PhonemizerJsPhonemizer();
  #disposed = false;

  static async create(options: BrowserKittenTtsOptions = {}): Promise<BrowserKittenTts> {
    options.signal?.throwIfAborted();
    const repoAssets =
      options.repoId && (!options.config || !options.modelUrl || !options.voicesUrl)
        ? await (async () => {
            const normalized = normalizeKittenTtsRepoReference({
              repoId: options.repoId!,
              revision: options.revision,
              repoBaseUrl: options.repoBaseUrl,
              configFilename: options.configFilename,
            });
            const configUrl = buildKittenTtsRepoFileUrl(normalized, normalized.configFilename);
            const bytes = await fetchBrowserAsset(configUrl, {
              ...options,
              expectedSha256: options.integrity?.[normalized.configFilename],
              onProgress: (loaded, total) =>
                options.onDownloadProgress?.(normalized.configFilename, loaded, total),
            });
            return resolveKittenTtsRepoAssetsFromConfig(
              normalized,
              JSON.parse(new TextDecoder().decode(bytes)),
            );
          })()
        : undefined;
    if (repoAssets) {
      options.onProgress?.("repo-assets-ready");
    }

    const shouldLoadManifest =
      !!options.manifest ||
      !!options.manifestUrl ||
      (!repoAssets && (!options.config || !options.modelUrl || !options.voicesUrl));
    const manifestUrl = shouldLoadManifest
      ? new URL(options.manifestUrl ?? "/.context/reference-fixtures/manifest.json", self.location.href).toString()
      : undefined;
    const manifest = options.manifest ?? (manifestUrl ? await loadManifest(manifestUrl, options) : undefined);
    if (manifest) {
      options.onProgress?.("manifest-loaded");
    }
    const config = options.config ?? repoAssets?.config ?? (manifest ? runtimeConfigFromManifest(manifest) : undefined);
    if (!config) {
      throw new Error("config is required when no manifest is provided");
    }

    const resolvedModelUrl =
      options.modelUrl ??
      repoAssets?.modelUrl ??
      (manifest?.model_asset_path && manifestUrl ? resolveAssetUrl(manifest.model_asset_path, manifestUrl) : undefined);
    if (!resolvedModelUrl) {
      throw new Error("modelUrl is required when no manifest-backed asset path is available");
    }

    const executionMode = options.executionMode ?? "auto";
    const ort = await (options.ortModuleLoader?.(executionMode) ?? loadOrtModule(executionMode, options.ortModuleUrls));
    options.onProgress?.("ort-loaded");

    ort.env.logLevel = options.logLevel ?? "warning";
    const numThreads =
      options.numThreads ??
      (executionMode === "wasm"
        ? 1
        : self.crossOriginIsolated
          ? Math.min(4, navigator.hardwareConcurrency || 1)
          : 1);
    ort.env.wasm.numThreads = numThreads;

    const modelFilename = assetFilename(resolvedModelUrl, "model.onnx");
    const modelPromise = fetchBrowserAsset(resolvedModelUrl, {
      ...options,
      expectedSha256: options.integrity?.[modelFilename],
      onProgress: (loaded, total) => options.onDownloadProgress?.(modelFilename, loaded, total),
    });
    const voicesPromise = loadVoices(manifest, {
      manifestUrl,
      voicesUrl: options.voicesUrl ?? repoAssets?.voicesUrl,
      options,
    }).then(({ voices, resolvedVoicesUrl }) => {
      options.onProgress?.("voices-loaded");
      return { voices, resolvedVoicesUrl };
    });
    const sessionPromise = modelPromise.then((modelBytes) => createSessionWithFallback(ort, modelBytes, executionMode)).then((result) => {
      options.onProgress?.("session-created");
      return result;
    });
    const [{ voices, resolvedVoicesUrl }, { session, executionProviders }] = await Promise.all([
      voicesPromise,
      sessionPromise,
    ]);
    options.signal?.throwIfAborted();
    options.onProgress?.("runtime-ready");

    return new BrowserKittenTts({
      ort,
      manifest,
      manifestUrl,
      repo: repoAssets
        ? {
            repoId: repoAssets.repoId,
            revision: repoAssets.revision,
            repoBaseUrl: repoAssets.repoBaseUrl,
            configFilename: repoAssets.configFilename,
          }
        : undefined,
      config,
      modelUrl: resolvedModelUrl,
      voicesUrl: options.voicesUrl ?? repoAssets?.voicesUrl ?? resolvedVoicesUrl,
      session,
      executionProviders,
      voices,
      executionMode,
      numThreads,
    });
  }

  constructor(state: BrowserKittenTtsState) {
    this.#state = state;
  }

  get manifest(): FixtureManifest | undefined {
    return this.#state.manifest;
  }

  get manifestUrl(): string | undefined {
    return this.#state.manifestUrl;
  }

  get config(): KittenTtsRuntimeConfig {
    return this.#state.config;
  }

  get repo(): KittenTtsRepoReference | undefined {
    return this.#state.repo;
  }

  get modelUrl(): string {
    return this.#state.modelUrl;
  }

  get voicesUrl(): string {
    return this.#state.voicesUrl;
  }

  get executionProviders(): readonly string[] {
    return this.#state.executionProviders;
  }

  get executionMode(): "auto" | "wasm" | "webgpu" {
    return this.#state.executionMode;
  }

  get numThreads(): number {
    return this.#state.numThreads;
  }

  async synthesize(request: BrowserSynthesisRequest): Promise<BrowserSynthesisResult> {
    if (this.#disposed) {
      throw new Error("browser runtime has been released");
    }
    request.signal?.throwIfAborted();

    const pipeline = await buildPipelineFeeds({
      text: request.text,
      voice: request.voice,
      speed: request.speed ?? 1,
      cleanText: request.cleanText ?? true,
      phonemizer: this.#phonemizer,
      voices: this.#state.voices,
      speedPriors: this.#state.config.speedPriors,
      voiceAliases: this.#state.config.voiceAliases,
    });

    const chunks: BrowserSynthesisChunk[] = [];
    for (const chunk of pipeline.chunks) {
      request.signal?.throwIfAborted();
      const { audio, durations } = await runChunk(this.#state.ort, this.#state.session, chunk);
      request.signal?.throwIfAborted();
      chunks.push({
        ...chunk,
        audio,
        durations,
      });
    }

    return {
      sampleRate: this.#state.config.sampleRate,
      executionProviders: [...this.#state.executionProviders],
      executionMode: this.#state.executionMode,
      cleanedText: pipeline.cleanedText,
      chunks,
      audio: concatenateAudioSegments(chunks.map((chunk) => chunk.audio)),
    };
  }

  async release(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await this.#state.session.release();
  }
}

export async function createBrowserKittenTts(options: BrowserKittenTtsOptions = {}): Promise<BrowserKittenTts> {
  return BrowserKittenTts.create(options);
}
