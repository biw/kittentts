import type { NodeKittenTtsOptions, NodeSynthesisResult } from "../node/runtime.js";
import { createNodeKittenTts } from "../node/runtime.js";
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

export interface KittenTtsNodeOptions extends Omit<NodeKittenTtsOptions, "repoId" | "revision" | "onProgress"> {
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

const NODE_PROGRESS: Record<string, KittenTtsProgress["phase"]> = {
  "repo-assets-ready": "downloading-voices",
  "manifest-loaded": "downloading-config",
  "voices-loaded": "loading-voices",
  "session-created": "creating-session",
  "runtime-ready": "ready",
};

function nodeCapabilities(model: KittenTtsModelId, executionProviders: readonly string[]): KittenTtsCapabilities {
  return {
    runtime: "node",
    model,
    transport: "direct",
    executionMode: "native",
    executionProviders: [...executionProviders],
    worker: false,
    webGpu: executionProviders.includes("webgpu"),
    wasm: false,
    native: true,
    crossOriginIsolated: false,
    threads: 1,
  };
}

export class KittenTTS extends KittenTtsSession {
  static async create(options: KittenTtsNodeOptions = {}): Promise<KittenTTS> {
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
        ...runtimeOptions
      } = options;
      const repoId = options.repoId ?? (
        !options.manifest && !options.manifestPath && !(options.config && options.modelPath && options.voicesPath)
          ? definition.repoId
          : undefined
      );
      const revision = options.revision ?? (repoId === definition.repoId ? definition.revision : undefined);
      const useRegistryIntegrity = repoId === definition.repoId && revision === definition.revision;
      const runtime = await createNodeKittenTts({
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
          runtimeOptions.onDownloadProgress?.(asset, loadedBytes, totalBytes);
          onProgress?.({
            phase: asset.endsWith(".onnx") ? "downloading-model" : "downloading-voices",
            loadedBytes,
            totalBytes,
            progress: totalBytes ? loadedBytes / totalBytes : undefined,
            detail: asset,
          });
        },
        onProgress: (phase) => onProgress?.({ phase: NODE_PROGRESS[phase] ?? "loading-runtime", detail: phase }),
      });
      options.signal?.throwIfAborted();
      backend = {
        capabilities: nodeCapabilities(model, runtime.executionProviders),
        synthesize: (request: KittenTtsBackendRequest) => runtime.synthesize(request) as Promise<NodeSynthesisResult>,
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
export { clearNodeKittenTtsCache, nodeKittenTtsCacheInfo } from "../node/repo-assets.js";
export { runtimeConfigFromManifest } from "../core/runtime-config.js";
