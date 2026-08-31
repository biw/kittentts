import type { KittenTtsRuntimeConfig } from "./runtime-config.js";

export interface KittenTtsRepoReference {
  repoId: string;
  revision?: string;
  repoBaseUrl?: string;
  configFilename?: string;
}

export interface KittenTtsRepoConfigFile {
  type?: string;
  model_file: string;
  voices: string;
  sample_rate?: number;
  speed_priors?: Record<string, number>;
  voice_aliases?: Record<string, string>;
}

export interface ResolvedKittenTtsRepoAssets {
  repoId: string;
  revision: string;
  repoBaseUrl: string;
  configFilename: string;
  configUrl: string;
  modelUrl: string;
  voicesUrl: string;
  config: KittenTtsRuntimeConfig;
  rawConfig: KittenTtsRepoConfigFile;
}

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

const DEFAULT_REPO_BASE_URL = "https://huggingface.co/";
const DEFAULT_REVISION = "main";
const DEFAULT_CONFIG_FILENAME = "config.json";
const DEFAULT_SAMPLE_RATE = 24000;

function encodePathSegments(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`invalid repository path '${value}'`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`invalid repository path segment '${segment}'`);
    }
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function normalizeKittenTtsRepoId(repoId: string): string {
  return repoId.includes("/") ? repoId : `KittenML/${repoId}`;
}

export function normalizeKittenTtsRepoReference(reference: KittenTtsRepoReference) {
  return {
    repoId: normalizeKittenTtsRepoId(reference.repoId),
    revision: reference.revision ?? DEFAULT_REVISION,
    repoBaseUrl: new URL(reference.repoBaseUrl ?? DEFAULT_REPO_BASE_URL).toString(),
    configFilename: reference.configFilename ?? DEFAULT_CONFIG_FILENAME,
  };
}

export function buildKittenTtsRepoFileUrl(reference: KittenTtsRepoReference, filename: string): string {
  const normalized = normalizeKittenTtsRepoReference(reference);
  return new URL(
    `${encodePathSegments(normalized.repoId)}/resolve/${encodeURIComponent(normalized.revision)}/${encodePathSegments(filename)}`,
    normalized.repoBaseUrl,
  ).toString();
}

export function runtimeConfigFromRepoConfig(rawConfig: KittenTtsRepoConfigFile): KittenTtsRuntimeConfig {
  return {
    sampleRate: rawConfig.sample_rate ?? DEFAULT_SAMPLE_RATE,
    speedPriors: rawConfig.speed_priors,
    voiceAliases: rawConfig.voice_aliases,
  };
}

export function assertSupportedRepoConfig(rawConfig: KittenTtsRepoConfigFile): void {
  if (typeof rawConfig.model_file !== "string" || !rawConfig.model_file.trim()) {
    throw new Error("repo config is missing 'model_file'");
  }
  if (typeof rawConfig.voices !== "string" || !rawConfig.voices.trim()) {
    throw new Error("repo config is missing 'voices'");
  }
  if (rawConfig.type && rawConfig.type !== "ONNX1" && rawConfig.type !== "ONNX2") {
    throw new Error(`unsupported repo config type '${rawConfig.type}'`);
  }
  if (rawConfig.sample_rate !== undefined && (!Number.isFinite(rawConfig.sample_rate) || rawConfig.sample_rate <= 0)) {
    throw new Error("repo config 'sample_rate' must be a finite number greater than zero");
  }
}

export function resolveKittenTtsRepoAssetsFromConfig(
  reference: KittenTtsRepoReference,
  rawConfig: KittenTtsRepoConfigFile,
): ResolvedKittenTtsRepoAssets {
  const normalized = normalizeKittenTtsRepoReference(reference);
  assertSupportedRepoConfig(rawConfig);
  return {
    ...normalized,
    configUrl: buildKittenTtsRepoFileUrl(normalized, normalized.configFilename),
    modelUrl: buildKittenTtsRepoFileUrl(normalized, rawConfig.model_file),
    voicesUrl: buildKittenTtsRepoFileUrl(normalized, rawConfig.voices),
    config: runtimeConfigFromRepoConfig(rawConfig),
    rawConfig,
  };
}

export async function resolveKittenTtsRepoAssets(
  reference: KittenTtsRepoReference,
  fetchImpl: FetchLike = fetch,
): Promise<ResolvedKittenTtsRepoAssets> {
  const normalized = normalizeKittenTtsRepoReference(reference);
  const configUrl = buildKittenTtsRepoFileUrl(normalized, normalized.configFilename);
  const response = await fetchImpl(configUrl);
  if (!response.ok) {
    throw new Error(`failed to load repo config: ${response.status} ${configUrl}`);
  }
  return resolveKittenTtsRepoAssetsFromConfig(normalized, (await response.json()) as KittenTtsRepoConfigFile);
}
