import type { PipelineChunkFeeds } from "../core/pipeline.js";

export type KittenTtsModelId = "nano" | "nano-int8" | "micro" | "mini";
export type KittenTtsExecutionMode = "auto" | "wasm" | "webgpu" | "native";
export type KittenTtsTransport = "direct" | "worker";

export interface KittenTtsProgress {
  phase:
    | "resolving-model"
    | "downloading-config"
    | "downloading-model"
    | "downloading-voices"
    | "downloading-phonemizer"
    | "loading-runtime"
    | "loading-voices"
    | "creating-session"
    | "ready"
    | "preprocessing"
    | "phonemizing"
    | "synthesizing"
    | "complete";
  progress?: number;
  loadedBytes?: number;
  totalBytes?: number;
  detail?: string;
}

export interface KittenTtsGenerateOptions {
  voice?: string;
  speed?: number;
  cleanText?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: KittenTtsProgress) => void;
}

export interface KittenTtsBackendRequest extends Required<Omit<KittenTtsGenerateOptions, "signal" | "onProgress">> {
  text: string;
  signal?: AbortSignal;
}

export interface KittenTtsBackendChunk extends PipelineChunkFeeds {
  audio: Float32Array;
  durations?: readonly number[];
}

export interface KittenTtsTokenTiming {
  chunkIndex: number;
  tokenIndex: number;
  tokenId: number;
  startSeconds: number;
  endSeconds: number;
}

export interface KittenTtsStreamChunk {
  index: number;
  text: string;
  isLast: boolean;
  result: import("./result.js").KittenTtsResult;
}

export interface KittenTtsBackendResult {
  sampleRate: number;
  executionProviders: string[];
  cleanedText: string;
  chunks: KittenTtsBackendChunk[];
  audio: Float32Array;
}

export interface KittenTtsCapabilities {
  runtime: "node" | "browser" | "react-native";
  model: KittenTtsModelId;
  transport: KittenTtsTransport;
  executionMode: KittenTtsExecutionMode;
  executionProviders: readonly string[];
  worker: boolean;
  webGpu: boolean;
  wasm: boolean;
  native: boolean;
  crossOriginIsolated: boolean;
  threads: number;
}

export interface KittenTtsBackend {
  readonly capabilities: KittenTtsCapabilities;
  synthesize(request: KittenTtsBackendRequest): Promise<KittenTtsBackendResult>;
  release(): Promise<void>;
}

export interface KittenTtsAudioPlayer {
  play(audio: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<void>;
  stop?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
