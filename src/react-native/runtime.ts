import type { Phonemizer } from "../core/phonemizer.js";
import { buildPipelineFeeds, type PipelineChunkFeeds } from "../core/pipeline.js";
import { type KittenTtsRuntimeConfig } from "../core/runtime-config.js";
import type { KittenTtsRepoReference } from "../core/repo-assets.js";
import { loadVoicesNpz, type VoicesNpz } from "../core/voices-npz.js";
import { base64ToUint8Array } from "../audio/base64.js";
import {
  downloadReactNativeKittenTtsRepoAssets,
  type ReactNativeKittenTtsRepoOptions,
} from "./repo-assets.js";
import {
  loadReactNativeFileSystem,
  loadReactNativeOrt,
  type ReactNativeFileSystem,
  type ReactNativeOrtModule,
  type ReactNativeOrtSession,
} from "./types.js";
import {
  createReactNativeCePhonemizer,
  type ReactNativeCePhonemizerOptions,
} from "./phonemizer.js";

export interface ReactNativeKittenTtsOptions {
  config?: KittenTtsRuntimeConfig;
  repoId?: string;
  revision?: string;
  repoBaseUrl?: string;
  configFilename?: string;
  cacheDir?: string;
  forceDownload?: boolean;
  signal?: AbortSignal;
  retries?: number;
  integrity?: Record<string, string>;
  onDownloadProgress?: (asset: string, loadedBytes: number, totalBytes?: number) => void;
  onProgress?: (phase: string) => void;
  modelPath?: string;
  voicesPath?: string;
  phonemizer?: Phonemizer;
  phonemizerOptions?: Omit<ReactNativeCePhonemizerOptions, "fileSystem" | "signal">;
  fileSystem?: ReactNativeFileSystem;
  ortModule?: ReactNativeOrtModule;
  sessionOptions?: Record<string, unknown>;
  numThreads?: number;
}

export interface ReactNativeSynthesisRequest {
  text: string;
  voice: string;
  speed?: number;
  cleanText?: boolean;
  signal?: AbortSignal;
}

export interface ReactNativeSynthesisChunk extends PipelineChunkFeeds {
  audio: Float32Array;
  durations?: number[];
}

export interface ReactNativeSynthesisResult {
  sampleRate: number;
  executionProviders: string[];
  cleanedText: string;
  chunks: ReactNativeSynthesisChunk[];
  audio: Float32Array;
}

interface ReactNativeKittenTtsState {
  repo?: KittenTtsRepoReference;
  config: KittenTtsRuntimeConfig;
  modelPath: string;
  voicesPath: string;
  session: ReactNativeOrtSession;
  ort: ReactNativeOrtModule;
  executionProviders: string[];
  voices: VoicesNpz;
  phonemizer: Phonemizer;
  numThreads: number;
}

const TRIM_SAMPLES = 5000;

function trimModelAudio(audio: Float32Array): Float32Array {
  return audio.slice(0, Math.max(0, audio.length - TRIM_SAMPLES));
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

function normalizeExecutionProviders(sessionOptions?: Record<string, unknown>): string[] {
  const providers = sessionOptions?.executionProviders;
  if (!Array.isArray(providers) || providers.length === 0) return ["cpu"];
  return providers.map((provider) => {
    if (typeof provider === "string") return provider;
    if (provider && typeof provider === "object" && "name" in provider) return String(provider.name);
    return String(provider);
  });
}

async function loadVoices(fileSystem: ReactNativeFileSystem, voicesPath: string): Promise<VoicesNpz> {
  return loadVoicesNpz(base64ToUint8Array(await fileSystem.readFile(voicesPath, "base64")));
}

async function runChunk(
  ort: ReactNativeOrtModule,
  session: ReactNativeOrtSession,
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
  const firstOutput = outputs[session.outputNames[0] ?? "waveform"];
  if (!firstOutput || !(firstOutput.data instanceof Float32Array)) {
    throw new Error("model returned no Float32Array output");
  }
  const durationOutput = outputs.duration;
  const durationData = durationOutput?.data;
  const durations = durationData && (
    durationData instanceof BigInt64Array ||
    durationData instanceof BigUint64Array ||
    durationData instanceof Int32Array ||
    durationData instanceof Uint32Array
  ) ? Array.from(durationData, Number) : undefined;
  return { audio: trimModelAudio(firstOutput.data), durations };
}

export class ReactNativeKittenTts {
  readonly #state: ReactNativeKittenTtsState;
  #disposed = false;

  static async create(options: ReactNativeKittenTtsOptions = {}): Promise<ReactNativeKittenTts> {
    options.signal?.throwIfAborted();
    const fileSystem = options.fileSystem ?? await loadReactNativeFileSystem();
    const ort = options.ortModule ?? await loadReactNativeOrt();
    let repo: KittenTtsRepoReference | undefined;
    let config = options.config;
    let modelPath = options.modelPath;
    let voicesPath = options.voicesPath;

    if (!config || !modelPath || !voicesPath) {
      if (!options.repoId) {
        throw new Error("repoId is required unless config, modelPath, and voicesPath are all provided");
      }
      const repoAssets = await downloadReactNativeKittenTtsRepoAssets({
        repoId: options.repoId,
        revision: options.revision,
        repoBaseUrl: options.repoBaseUrl,
        configFilename: options.configFilename,
        cacheDir: options.cacheDir,
        fileSystem,
        forceDownload: options.forceDownload,
        signal: options.signal,
        retries: options.retries,
        integrity: options.integrity,
        onDownloadProgress: options.onDownloadProgress,
      });
      config = options.config ?? repoAssets.config;
      modelPath = options.modelPath ?? repoAssets.modelPath;
      voicesPath = options.voicesPath ?? repoAssets.voicesPath;
      repo = {
        repoId: repoAssets.repoId,
        revision: repoAssets.revision,
        repoBaseUrl: repoAssets.repoBaseUrl,
        configFilename: repoAssets.configFilename,
      };
      options.onProgress?.("repo-assets-ready");
    }

    const resolvedConfig = config;
    const resolvedModelPath = modelPath;
    const resolvedVoicesPath = voicesPath;
    if (!resolvedConfig || !resolvedModelPath || !resolvedVoicesPath) {
      throw new Error("React Native runtime assets could not be resolved");
    }

    const numThreads = Math.max(1, Math.floor(options.numThreads ?? 1));
    const sessionOptions = {
      graphOptimizationLevel: "all",
      intraOpNumThreads: numThreads,
      ...options.sessionOptions,
    };
    const voicesPromise = loadVoices(fileSystem, resolvedVoicesPath).then((voices) => {
      options.onProgress?.("voices-loaded");
      return voices;
    });
    const sessionPromise = ort.InferenceSession.create(resolvedModelPath, sessionOptions).then((session) => {
      options.onProgress?.("session-created");
      return session;
    });
    const [voicesResult, sessionResult] = await Promise.allSettled([voicesPromise, sessionPromise]);
    if (voicesResult.status === "rejected") {
      if (sessionResult.status === "fulfilled") await sessionResult.value.release();
      throw voicesResult.reason;
    }
    if (sessionResult.status === "rejected") throw sessionResult.reason;
    const voices = voicesResult.value;
    const session = sessionResult.value;
    let phonemizer: Phonemizer | undefined;
    try {
      options.signal?.throwIfAborted();
      phonemizer = options.phonemizer ?? await createReactNativeCePhonemizer({
        ...options.phonemizerOptions,
        fileSystem,
        signal: options.signal,
        onDownloadProgress: (asset, loadedBytes, totalBytes) => {
          options.phonemizerOptions?.onDownloadProgress?.(asset, loadedBytes, totalBytes);
          options.onDownloadProgress?.(asset, loadedBytes, totalBytes);
        },
      });
      options.onProgress?.("phonemizer-loaded");
      options.signal?.throwIfAborted();
      options.onProgress?.("runtime-ready");

      return new ReactNativeKittenTts({
        repo,
        config: resolvedConfig,
        modelPath: resolvedModelPath,
        voicesPath: resolvedVoicesPath,
        session,
        ort,
        executionProviders: normalizeExecutionProviders(sessionOptions),
        voices,
        phonemizer,
        numThreads,
      });
    } catch (error) {
      await session.release();
      if (!options.phonemizer) await phonemizer?.dispose?.();
      throw error;
    }
  }

  constructor(state: ReactNativeKittenTtsState) {
    this.#state = state;
  }

  get config(): KittenTtsRuntimeConfig {
    return this.#state.config;
  }

  get repo(): KittenTtsRepoReference | undefined {
    return this.#state.repo;
  }

  get modelPath(): string {
    return this.#state.modelPath;
  }

  get voicesPath(): string {
    return this.#state.voicesPath;
  }

  get executionProviders(): readonly string[] {
    return this.#state.executionProviders;
  }

  get numThreads(): number {
    return this.#state.numThreads;
  }

  async synthesize(request: ReactNativeSynthesisRequest): Promise<ReactNativeSynthesisResult> {
    if (this.#disposed) throw new Error("React Native runtime has been released");
    request.signal?.throwIfAborted();
    const pipeline = await buildPipelineFeeds({
      text: request.text,
      voice: request.voice,
      speed: request.speed ?? 1,
      cleanText: request.cleanText ?? true,
      phonemizer: this.#state.phonemizer,
      voices: this.#state.voices,
      speedPriors: this.#state.config.speedPriors,
      voiceAliases: this.#state.config.voiceAliases,
    });

    const chunks: ReactNativeSynthesisChunk[] = [];
    for (const chunk of pipeline.chunks) {
      request.signal?.throwIfAborted();
      const { audio, durations } = await runChunk(this.#state.ort, this.#state.session, chunk);
      request.signal?.throwIfAborted();
      chunks.push({ ...chunk, audio, durations });
    }
    return {
      sampleRate: this.#state.config.sampleRate,
      executionProviders: [...this.#state.executionProviders],
      cleanedText: pipeline.cleanedText,
      chunks,
      audio: concatenateAudioSegments(chunks.map((chunk) => chunk.audio)),
    };
  }

  async release(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#state.session.release();
    await this.#state.phonemizer.dispose?.();
  }
}

export async function createReactNativeKittenTts(
  options: ReactNativeKittenTtsOptions = {},
): Promise<ReactNativeKittenTts> {
  return ReactNativeKittenTts.create(options);
}
