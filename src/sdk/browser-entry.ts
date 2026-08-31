import type { BrowserKittenTtsOptions, BrowserSynthesisResult } from "../browser/runtime.js";
import { createBrowserKittenTts } from "../browser/runtime.js";
import { BrowserKittenTtsWorkerClient } from "../browser/worker-client.js";
import type {
  KittenTtsAudioPlayer,
  KittenTtsBackend,
  KittenTtsBackendRequest,
  KittenTtsCapabilities,
  KittenTtsModelId,
  KittenTtsProgress,
  KittenTtsTransport,
} from "./contracts.js";
import { resolveKittenTtsModel } from "./model-registry.js";
import { KittenTtsSession } from "./session.js";
import { BrowserAudioPlayer } from "../browser/playback.js";

export interface KittenTtsBrowserOptions extends Omit<BrowserKittenTtsOptions, "repoId" | "revision" | "onProgress"> {
  model?: KittenTtsModelId;
  repoId?: string;
  revision?: string;
  transport?: KittenTtsTransport;
  workerUrl?: URL | string;
  defaultVoice?: string;
  speed?: number;
  player?: KittenTtsAudioPlayer;
  onProgress?: (event: KittenTtsProgress) => void;
  signal?: AbortSignal;
  /** Primarily useful for deterministic integration tests and custom runtimes. */
  backend?: KittenTtsBackend;
}

const BROWSER_PROGRESS: Record<string, KittenTtsProgress["phase"]> = {
  "repo-assets-ready": "downloading-config",
  "manifest-loaded": "downloading-config",
  "ort-loaded": "loading-runtime",
  "voices-loaded": "loading-voices",
  "session-created": "creating-session",
  "runtime-ready": "ready",
};

function browserCapabilities(
  model: KittenTtsModelId,
  transport: KittenTtsTransport,
  executionProviders: readonly string[],
  threads: number,
): KittenTtsCapabilities {
  const webGpu = executionProviders.includes("webgpu");
  return {
    runtime: "browser",
    model,
    transport,
    executionMode: webGpu ? "webgpu" : "wasm",
    executionProviders: [...executionProviders],
    worker: transport === "worker",
    webGpu,
    wasm: executionProviders.includes("wasm"),
    native: false,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    threads,
  };
}

export class KittenTTS extends KittenTtsSession {
  static async create(options: KittenTtsBrowserOptions = {}): Promise<KittenTTS> {
    const model = options.model ?? "nano";
    const definition = resolveKittenTtsModel(model);
    const transport = options.transport ?? "worker";
    options.signal?.throwIfAborted();
    options.onProgress?.({ phase: "resolving-model", detail: definition.repoId });

    let backend = options.backend;
    if (!backend) {
      const {
        backend: _backend,
        model: _model,
        transport: _transport,
        workerUrl,
        defaultVoice: _defaultVoice,
        speed: _speed,
        player: _player,
        signal: _signal,
        onProgress,
        onDownloadProgress,
        ...runtimeOptions
      } = options;
      const repoId = options.repoId ?? (
        !options.manifest && !options.manifestUrl && !(options.config && options.modelUrl && options.voicesUrl)
          ? definition.repoId
          : undefined
      );
      const revision = options.revision ?? (repoId === definition.repoId ? definition.revision : undefined);
      const useRegistryIntegrity = repoId === definition.repoId && revision === definition.revision;
      const init = {
        ...runtimeOptions,
        repoId,
        revision,
        integrity: options.integrity ?? (useRegistryIntegrity ? {
          "config.json": definition.configSha256,
          [definition.modelFilename]: definition.modelSha256,
          [definition.voicesFilename]: definition.voicesSha256,
        } : undefined),
      };

      if (transport === "worker") {
        if (options.fetchImpl || options.ortModuleLoader) {
          throw new Error("worker transport requires serializable options; use URLs instead of fetchImpl or ortModuleLoader");
        }
        const client = await BrowserKittenTtsWorkerClient.create({
          workerUrl,
          init,
          signal: options.signal,
          onProgress: (phase, details) => {
            if (details?.asset && details.loadedBytes !== undefined) {
              onDownloadProgress?.(details.asset, details.loadedBytes, details.totalBytes);
            }
            onProgress?.({
              phase: phase === "asset-download"
              ? details?.asset?.endsWith(".onnx") ? "downloading-model" : details?.asset?.endsWith(".json") ? "downloading-config" : "downloading-voices"
                : BROWSER_PROGRESS[phase] ?? "loading-runtime",
              detail: details?.asset ?? phase,
              loadedBytes: details?.loadedBytes,
              totalBytes: details?.totalBytes,
              progress: details?.totalBytes ? (details.loadedBytes ?? 0) / details.totalBytes : undefined,
            });
          },
        });
        const info = client.runtimeInfo;
        if (!info) throw new Error("worker returned no runtime information");
        backend = {
          capabilities: browserCapabilities(model, "worker", info.executionProviders, info.numThreads),
          synthesize: (request: KittenTtsBackendRequest) => {
            const { signal, ...serializable } = request;
            return client.synthesize<BrowserSynthesisResult>(serializable, signal);
          },
          release: () => client.release(),
        };
      } else {
        const runtime = await createBrowserKittenTts({
          ...init,
          onProgress: (phase) => onProgress?.({ phase: BROWSER_PROGRESS[phase] ?? "loading-runtime", detail: phase }),
          onDownloadProgress: (asset, loadedBytes, totalBytes) => {
            onDownloadProgress?.(asset, loadedBytes, totalBytes);
            onProgress?.({
              phase: asset.endsWith(".onnx") ? "downloading-model" : asset.endsWith(".json") ? "downloading-config" : "downloading-voices",
              detail: asset,
              loadedBytes,
              totalBytes,
              progress: totalBytes ? loadedBytes / totalBytes : undefined,
            });
          },
        });
        backend = {
          capabilities: browserCapabilities(model, "direct", runtime.executionProviders, runtime.numThreads),
          synthesize: (request: KittenTtsBackendRequest) => runtime.synthesize(request),
          release: () => runtime.release(),
        };
      }
      options.signal?.throwIfAborted();
    }

    options.onProgress?.({ phase: "ready" });
    return new KittenTTS(backend, {
      model,
      defaultVoice: options.defaultVoice,
      speed: options.speed,
      player: options.player ?? new BrowserAudioPlayer(),
    });
  }
}

export * from "./contracts.js";
export * from "./model-registry.js";
export { KittenTtsResult } from "./result.js";
export { KittenTtsSession } from "./session.js";
export * from "./stream.js";
export { browserAssetCacheInfo, clearBrowserAssetCache } from "../browser/asset-cache.js";
export { runtimeConfigFromManifest } from "../core/runtime-config.js";
