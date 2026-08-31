import type {
  ReactNativeKittenTtsOptions,
  ReactNativeSynthesisResult,
} from "../react-native/runtime.js";
import { createReactNativeKittenTts } from "../react-native/runtime.js";
import type {
  KittenTtsAudioPlayer,
  KittenTtsBackend,
  KittenTtsBackendRequest,
  KittenTtsCapabilities,
  KittenTtsModelId,
  KittenTtsProgress,
} from "./contracts.js";
import { resolveKittenTtsModel } from "./model-registry.js";
import { KittenTtsSession } from "./session.js";

export interface KittenTtsReactNativeOptions extends Omit<ReactNativeKittenTtsOptions, "repoId" | "revision" | "onProgress"> {
  model?: KittenTtsModelId;
  repoId?: string;
  revision?: string;
  defaultVoice?: string;
  speed?: number;
  player?: KittenTtsAudioPlayer;
  onProgress?: (event: KittenTtsProgress) => void;
  signal?: AbortSignal;
  /** Primarily useful for deterministic integration tests and custom runtimes. */
  backend?: KittenTtsBackend;
}

const REACT_NATIVE_PROGRESS: Record<string, KittenTtsProgress["phase"]> = {
  "repo-assets-ready": "loading-runtime",
  "voices-loaded": "loading-voices",
  "session-created": "creating-session",
  "phonemizer-loaded": "loading-runtime",
  "runtime-ready": "ready",
};

function reactNativeCapabilities(
  model: KittenTtsModelId,
  executionProviders: readonly string[],
  threads: number,
): KittenTtsCapabilities {
  return {
    runtime: "react-native",
    model,
    transport: "direct",
    executionMode: "native",
    executionProviders: [...executionProviders],
    worker: false,
    webGpu: false,
    wasm: false,
    native: true,
    crossOriginIsolated: false,
    threads,
  };
}

export class KittenTTS extends KittenTtsSession {
  static async create(options: KittenTtsReactNativeOptions = {}): Promise<KittenTTS> {
    const model = options.model ?? "nano";
    const definition = resolveKittenTtsModel(model);
    options.signal?.throwIfAborted();
    options.onProgress?.({ phase: "resolving-model", detail: definition.repoId });

    let backend = options.backend;
    if (!backend) {
      const {
        backend: _backend,
        model: _model,
        defaultVoice: _defaultVoice,
        speed: _speed,
        player: _player,
        signal: _signal,
        onProgress,
        onDownloadProgress,
        ...runtimeOptions
      } = options;
      const repoId = options.repoId ?? (
        !(options.config && options.modelPath && options.voicesPath) ? definition.repoId : undefined
      );
      const revision = options.revision ?? (repoId === definition.repoId ? definition.revision : undefined);
      const useRegistryIntegrity = repoId === definition.repoId && revision === definition.revision;
      const runtime = await createReactNativeKittenTts({
        ...runtimeOptions,
        repoId,
        revision,
        signal: options.signal,
        integrity: options.integrity ?? (useRegistryIntegrity ? {
          "config.json": definition.configSha256,
          [definition.modelFilename]: definition.modelSha256,
          [definition.voicesFilename]: definition.voicesSha256,
        } : undefined),
        onDownloadProgress: (asset, loadedBytes, totalBytes) => {
          onDownloadProgress?.(asset, loadedBytes, totalBytes);
          onProgress?.({
            phase: asset.startsWith("phonemizer-")
              ? "downloading-phonemizer"
              : asset.endsWith(".onnx")
                ? "downloading-model"
                : asset.endsWith(".json")
                  ? "downloading-config"
                  : "downloading-voices",
            loadedBytes,
            totalBytes,
            progress: totalBytes ? loadedBytes / totalBytes : undefined,
            detail: asset,
          });
        },
        onProgress: (phase) => onProgress?.({
          phase: REACT_NATIVE_PROGRESS[phase] ?? "loading-runtime",
          detail: phase,
        }),
      });
      try {
        options.signal?.throwIfAborted();
      } catch (error) {
        await runtime.release();
        throw error;
      }
      backend = {
        capabilities: reactNativeCapabilities(model, runtime.executionProviders, runtime.numThreads),
        synthesize: (request: KittenTtsBackendRequest) => runtime.synthesize(request) as Promise<ReactNativeSynthesisResult>,
        release: () => runtime.release(),
      };
    }

    options.onProgress?.({ phase: "ready" });
    return new KittenTTS(backend, {
      model,
      defaultVoice: options.defaultVoice,
      speed: options.speed,
      player: options.player,
    });
  }
}

export * from "./contracts.js";
export * from "./model-registry.js";
export { KittenTtsResult } from "./result.js";
export { KittenTtsSession } from "./session.js";
export * from "./stream.js";
export {
  clearReactNativeKittenTtsCache,
  reactNativeKittenTtsCacheInfo,
} from "../react-native/repo-assets.js";
export type {
  ReactNativeFileSystem,
  ReactNativeOrtModule,
} from "../react-native/types.js";
export {
  createExpoAudioPlayer,
  createReactNativeFileAudioPlayer,
  createReactNativeSoundPlayer,
  type ExpoAudioModule,
  type ReactNativeFilePlayer,
  type ReactNativePlaybackOptions,
  type ReactNativeSoundConstructor,
} from "../react-native/playback.js";
export {
  ReactNativeCePhonemizer,
  createReactNativeCePhonemizer,
  type ReactNativeCePhonemizerOptions,
} from "../react-native/phonemizer.js";
