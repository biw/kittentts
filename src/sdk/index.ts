import type { BrowserOrtModuleUrls } from "../browser/runtime.js";
import type { KittenTtsRuntimeConfig } from "../core/runtime-config.js";
import type {
  KittenTtsAudioPlayer,
  KittenTtsBackend,
  KittenTtsExecutionMode,
  KittenTtsModelId,
  KittenTtsProgress,
  KittenTtsTransport,
} from "./contracts.js";
import { KittenTtsSession } from "./session.js";

/** Environment-neutral options for the conditional root export. */
export interface KittenTtsOptions {
  model?: KittenTtsModelId;
  defaultVoice?: string;
  speed?: number;
  player?: KittenTtsAudioPlayer;
  onProgress?: (event: KittenTtsProgress) => void;
  signal?: AbortSignal;
  backend?: KittenTtsBackend;
  repoId?: string;
  revision?: string;
  repoBaseUrl?: string;
  configFilename?: string;
  config?: KittenTtsRuntimeConfig;
  forceDownload?: boolean;
  retries?: number;
  integrity?: Record<string, string>;
  modelPath?: string;
  voicesPath?: string;
  manifestPath?: string;
  cacheDir?: string;
  modelUrl?: string;
  voicesUrl?: string;
  manifestUrl?: string;
  cacheName?: string;
  transport?: KittenTtsTransport;
  executionMode?: Exclude<KittenTtsExecutionMode, "native">;
  workerUrl?: URL | string;
  ortModuleUrls?: BrowserOrtModuleUrls;
  numThreads?: number;
}

export declare class KittenTTS extends KittenTtsSession {
  static create(options?: KittenTtsOptions): Promise<KittenTTS>;
}

export * from "./contracts.js";
export * from "./model-registry.js";
export { KittenTtsResult } from "./result.js";
export { KittenTtsSession } from "./session.js";
export * from "./stream.js";
