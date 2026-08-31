import fs from "node:fs/promises";
import path from "node:path";
import ort from "onnxruntime-node";
import type { FixtureManifest } from "../core/phoneme-feeds.js";
import { PhonemizerJsPhonemizer, type Phonemizer } from "../core/phonemizer.js";
import { buildPipelineFeeds, type PipelineChunkFeeds } from "../core/pipeline.js";
import {
  runtimeConfigFromManifest,
  type KittenTtsRuntimeConfig,
} from "../core/runtime-config.js";
import type { FetchLike, KittenTtsRepoReference } from "../core/repo-assets.js";
import { loadVoicesNpz, type VoicesNpz } from "../core/voices-npz.js";
import { downloadNodeKittenTtsRepoAssets } from "./repo-assets.js";

export interface NodeKittenTtsOptions {
  manifestPath?: string;
  manifest?: FixtureManifest;
  config?: KittenTtsRuntimeConfig;
  repoId?: string;
  revision?: string;
  repoBaseUrl?: string;
  configFilename?: string;
  cacheDir?: string;
  fetchImpl?: FetchLike;
  forceDownload?: boolean;
  signal?: AbortSignal;
  retries?: number;
  integrity?: Record<string, string>;
  onDownloadProgress?: (asset: string, loadedBytes: number, totalBytes?: number) => void;
  modelPath?: string;
  voicesPath?: string;
  phonemizer?: Phonemizer;
  sessionOptions?: NonNullable<Parameters<typeof ort.InferenceSession.create>[1]>;
  onProgress?: (phase: string) => void;
}

export interface NodeSynthesisRequest {
  text: string;
  voice: string;
  speed?: number;
  cleanText?: boolean;
  signal?: AbortSignal;
}

export interface NodeSynthesisChunk extends PipelineChunkFeeds {
  audio: Float32Array;
  durations?: number[];
}

export interface NodeSynthesisResult {
  sampleRate: number;
  executionProviders: string[];
  cleanedText: string;
  chunks: NodeSynthesisChunk[];
  audio: Float32Array;
}

interface NodeKittenTtsState {
  manifest?: FixtureManifest;
  manifestPath?: string;
  repo?: KittenTtsRepoReference;
  config: KittenTtsRuntimeConfig;
  modelPath: string;
  voicesPath: string;
  session: ort.InferenceSession;
  executionProviders: string[];
  voices: VoicesNpz;
  phonemizer: Phonemizer;
}

const DEFAULT_MANIFEST_PATH = path.resolve(process.cwd(), ".context", "reference-fixtures", "manifest.json");
const TRIM_SAMPLES = 5000;

function trimModelAudio(audio: Float32Array): Float32Array {
  return audio.slice(0, audio.length - TRIM_SAMPLES);
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

function resolvePathFromManifest(manifestPath: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(path.dirname(manifestPath), filePath);
}

function resolveModelPath(
  manifest: FixtureManifest | undefined,
  { manifestPath, modelPath }: { manifestPath?: string; modelPath?: string },
): string {
  if (modelPath) {
    return path.resolve(modelPath);
  }
  if (manifest?.model_path && manifestPath) {
    return resolvePathFromManifest(manifestPath, manifest.model_path);
  }
  if (manifest?.model_asset_path && manifestPath) {
    return resolvePathFromManifest(manifestPath, manifest.model_asset_path);
  }
  throw new Error("modelPath is required when no manifest-backed asset path is available");
}

function resolveVoicesPath(
  manifest: FixtureManifest | undefined,
  { manifestPath, voicesPath }: { manifestPath?: string; voicesPath?: string },
): string {
  if (voicesPath) {
    return path.resolve(voicesPath);
  }
  if (manifest?.voices_asset_path && manifestPath) {
    return resolvePathFromManifest(manifestPath, manifest.voices_asset_path);
  }
  throw new Error("voicesPath is required when no manifest-backed asset path is available");
}

function normalizeExecutionProviders(
  sessionOptions?: NonNullable<Parameters<typeof ort.InferenceSession.create>[1]>,
): string[] {
  const providers = sessionOptions?.executionProviders;
  if (!providers || providers.length === 0) {
    return ["cpu"];
  }
  return providers.map((provider) => {
    if (typeof provider === "string") {
      return provider;
    }
    if (provider && typeof provider === "object" && "name" in provider && typeof provider.name === "string") {
      return provider.name;
    }
    return String(provider);
  });
}

async function loadManifest(manifestPath: string): Promise<FixtureManifest> {
  return JSON.parse(await fs.readFile(manifestPath, "utf8")) as FixtureManifest;
}

async function loadVoices(voicesPath: string): Promise<VoicesNpz> {
  return loadVoicesNpz(new Uint8Array(await fs.readFile(voicesPath)));
}

async function runChunk(session: ort.InferenceSession, chunk: PipelineChunkFeeds): Promise<{ audio: Float32Array; durations?: number[] }> {
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

export class NodeKittenTts {
  readonly #state: NodeKittenTtsState;
  #disposed = false;

  static async create(options: NodeKittenTtsOptions = {}): Promise<NodeKittenTts> {
    const repoAssets =
      options.repoId && (!options.config || !options.modelPath || !options.voicesPath)
        ? await downloadNodeKittenTtsRepoAssets({
            repoId: options.repoId,
            revision: options.revision,
            repoBaseUrl: options.repoBaseUrl,
            configFilename: options.configFilename,
            cacheDir: options.cacheDir,
            fetchImpl: options.fetchImpl,
            forceDownload: options.forceDownload,
            signal: options.signal,
            retries: options.retries,
            integrity: options.integrity,
            onDownloadProgress: options.onDownloadProgress,
          })
        : undefined;
    if (repoAssets) {
      options.onProgress?.("repo-assets-ready");
    }

    const shouldLoadManifest =
      !!options.manifest ||
      !!options.manifestPath ||
      (!repoAssets && (!options.config || !options.modelPath || !options.voicesPath));
    const manifestPath = shouldLoadManifest ? path.resolve(options.manifestPath ?? DEFAULT_MANIFEST_PATH) : undefined;
    const manifest =
      options.manifest ??
      (manifestPath ? await loadManifest(manifestPath) : undefined);
    if (manifest) {
      options.onProgress?.("manifest-loaded");
    }
    const config = options.config ?? repoAssets?.config ?? (manifest ? runtimeConfigFromManifest(manifest) : undefined);
    if (!config) {
      throw new Error("config is required when no manifest is provided");
    }

    const resolvedModelPath = options.modelPath ?? repoAssets?.modelPath ?? resolveModelPath(manifest, {
      manifestPath,
      modelPath: undefined,
    });
    const resolvedVoicesPath = options.voicesPath ?? repoAssets?.voicesPath ?? resolveVoicesPath(manifest, {
      manifestPath,
      voicesPath: undefined,
    });
    const phonemizer = options.phonemizer ?? new PhonemizerJsPhonemizer();

    const voicesPromise = loadVoices(resolvedVoicesPath).then((voices) => {
      options.onProgress?.("voices-loaded");
      return voices;
    });
    const sessionPromise = ort.InferenceSession.create(resolvedModelPath, options.sessionOptions).then((session) => {
      options.onProgress?.("session-created");
      return session;
    });
    const [voices, session] = await Promise.all([voicesPromise, sessionPromise]);
    options.onProgress?.("runtime-ready");

    return new NodeKittenTts({
      manifest,
      manifestPath,
      repo: repoAssets
        ? {
            repoId: repoAssets.repoId,
            revision: repoAssets.revision,
            repoBaseUrl: repoAssets.repoBaseUrl,
            configFilename: repoAssets.configFilename,
          }
        : undefined,
      config,
      modelPath: resolvedModelPath,
      voicesPath: resolvedVoicesPath,
      session,
      executionProviders: normalizeExecutionProviders(options.sessionOptions),
      voices,
      phonemizer,
    });
  }

  constructor(state: NodeKittenTtsState) {
    this.#state = state;
  }

  get manifest(): FixtureManifest | undefined {
    return this.#state.manifest;
  }

  get manifestPath(): string | undefined {
    return this.#state.manifestPath;
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

  async synthesize(request: NodeSynthesisRequest): Promise<NodeSynthesisResult> {
    if (this.#disposed) {
      throw new Error("node runtime has been released");
    }
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

    const chunks: NodeSynthesisChunk[] = [];
    for (const chunk of pipeline.chunks) {
      request.signal?.throwIfAborted();
      const { audio, durations } = await runChunk(this.#state.session, chunk);
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

export async function createNodeKittenTts(options: NodeKittenTtsOptions = {}): Promise<NodeKittenTts> {
  return NodeKittenTts.create(options);
}
