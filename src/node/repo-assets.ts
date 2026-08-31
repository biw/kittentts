import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  buildKittenTtsRepoFileUrl,
  normalizeKittenTtsRepoReference,
  resolveKittenTtsRepoAssetsFromConfig,
  type FetchLike,
  type KittenTtsRepoReference,
  type ResolvedKittenTtsRepoAssets,
} from "../core/repo-assets.js";
import { readResponseBytes } from "../core/response-bytes.js";

export interface NodeKittenTtsRepoOptions extends KittenTtsRepoReference {
  cacheDir?: string;
  fetchImpl?: FetchLike;
  forceDownload?: boolean;
  signal?: AbortSignal;
  retries?: number;
  integrity?: Record<string, string>;
  onDownloadProgress?: (asset: string, loadedBytes: number, totalBytes?: number) => void;
}

export interface DownloadedNodeKittenTtsRepoAssets extends ResolvedKittenTtsRepoAssets {
  cacheDir: string;
  configPath: string;
  modelPath: string;
  voicesPath: string;
}

export interface NodeKittenTtsCacheInfo {
  cacheDir: string;
  exists: boolean;
  files: Array<{ path: string; bytes: number }>;
  totalBytes: number;
}

export function defaultNodeKittenTtsCacheDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "kittentts-js");
  }
  return path.join(os.homedir(), ".cache", "kittentts-js");
}

function repoCacheDirectory(options: NodeKittenTtsRepoOptions): string {
  const normalized = normalizeKittenTtsRepoReference(options);
  return path.join(
    path.resolve(options.cacheDir ?? defaultNodeKittenTtsCacheDir()),
    safeRelativePath(normalized.repoId),
    safeRelativePath(normalized.revision),
  );
}

async function listFiles(root: string, current = root): Promise<Array<{ path: string; bytes: number }>> {
  const files: Array<{ path: string; bytes: number }> = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, entryPath));
    else if (entry.isFile()) files.push({ path: path.relative(root, entryPath), bytes: (await fs.stat(entryPath)).size });
  }
  return files;
}

export async function nodeKittenTtsCacheInfo(options: NodeKittenTtsRepoOptions): Promise<NodeKittenTtsCacheInfo> {
  const cacheDir = repoCacheDirectory(options);
  if (!(await fileExists(cacheDir))) return { cacheDir, exists: false, files: [], totalBytes: 0 };
  const files = await listFiles(cacheDir);
  return { cacheDir, exists: true, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

export async function clearNodeKittenTtsCache(options: NodeKittenTtsRepoOptions): Promise<boolean> {
  const cacheDir = repoCacheDirectory(options);
  const existed = await fileExists(cacheDir);
  await fs.rm(cacheDir, { recursive: true, force: true });
  return existed;
}

function safeRelativePath(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`invalid cache path '${value}'`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`invalid cache path segment '${segment}'`);
    }
  }
  return path.join(...segments);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function assertIntegrity(filePath: string, expectedSha256?: string): Promise<void> {
  if (!expectedSha256) return;
  const actual = await fileSha256(filePath);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`asset integrity check failed for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`);
  }
}

const downloadsInFlight = new Map<string, Promise<void>>();

async function downloadFile(
  url: string,
  destinationPath: string,
  fetchImpl: FetchLike,
  forceDownload: boolean,
  options: Pick<NodeKittenTtsRepoOptions, "signal" | "retries" | "onDownloadProgress"> & { expectedSha256?: string },
): Promise<void> {
  if (!forceDownload && (await fileExists(destinationPath))) {
    try {
      await assertIntegrity(destinationPath, options.expectedSha256);
      return;
    } catch {
      await fs.rm(destinationPath, { force: true });
    }
  }
  const existingDownload = downloadsInFlight.get(destinationPath);
  if (existingDownload) {
    await existingDownload;
    return;
  }

  const download = (async () => {
    const destinationDir = path.dirname(destinationPath);
    await fs.mkdir(destinationDir, { recursive: true });
    const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      let response: Response | undefined;
      let lastError: unknown;
      const retries = options.retries ?? 2;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        options.signal?.throwIfAborted();
        try {
          response = await fetchImpl(url, { signal: options.signal });
          if (response.ok || (response.status < 500 && response.status !== 408 && response.status !== 429)) break;
          lastError = new Error(`failed to download asset: ${response.status} ${url}`);
        } catch (error) {
          lastError = error;
          if (options.signal?.aborted) throw error;
        }
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
      if (!response?.ok) throw lastError ?? new Error(`failed to download asset: ${response?.status ?? "unknown"} ${url}`);
      const bytes = await readResponseBytes(response, {
        signal: options.signal,
        onProgress: (loaded, total) => options.onDownloadProgress?.(path.basename(destinationPath), loaded, total),
      });
      options.signal?.throwIfAborted();
      await fs.writeFile(temporaryPath, bytes);
      await assertIntegrity(temporaryPath, options.expectedSha256);
      try {
        await fs.rename(temporaryPath, destinationPath);
      } catch (error) {
        if (forceDownload || !(await fileExists(destinationPath))) {
          throw error;
        }
      }
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  })();
  downloadsInFlight.set(destinationPath, download);
  try {
    await download;
  } finally {
    if (downloadsInFlight.get(destinationPath) === download) {
      downloadsInFlight.delete(destinationPath);
    }
  }
}

export async function downloadNodeKittenTtsRepoAssets(
  options: NodeKittenTtsRepoOptions,
): Promise<DownloadedNodeKittenTtsRepoAssets> {
  const normalized = normalizeKittenTtsRepoReference(options);
  const cacheDir = path.resolve(options.cacheDir ?? defaultNodeKittenTtsCacheDir());
  const repoCacheDir = repoCacheDirectory(options);
  const configPath = path.join(repoCacheDir, safeRelativePath(normalized.configFilename));
  let resolved: ResolvedKittenTtsRepoAssets | undefined;
  if (!options.forceDownload && await fileExists(configPath)) {
    try {
      await assertIntegrity(configPath, options.integrity?.[normalized.configFilename]);
      const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
      resolved = resolveKittenTtsRepoAssetsFromConfig(normalized, rawConfig);
    } catch {
      await fs.rm(configPath, { force: true });
    }
  }
  if (!resolved) {
    await downloadFile(
      buildKittenTtsRepoFileUrl(normalized, normalized.configFilename),
      configPath,
      options.fetchImpl ?? fetch,
      !!options.forceDownload,
      {
        signal: options.signal,
        retries: options.retries,
        onDownloadProgress: options.onDownloadProgress,
        expectedSha256: options.integrity?.[normalized.configFilename],
      },
    );
    resolved = resolveKittenTtsRepoAssetsFromConfig(
      normalized,
      JSON.parse(await fs.readFile(configPath, "utf8")),
    );
  }
  options.signal?.throwIfAborted();
  const modelPath = path.join(repoCacheDir, safeRelativePath(resolved.rawConfig.model_file));
  const voicesPath = path.join(repoCacheDir, safeRelativePath(resolved.rawConfig.voices));

  await downloadFile(resolved.modelUrl, modelPath, options.fetchImpl ?? fetch, !!options.forceDownload, {
    signal: options.signal,
    retries: options.retries,
    onDownloadProgress: options.onDownloadProgress,
    expectedSha256: options.integrity?.[resolved.rawConfig.model_file],
  });
  await downloadFile(resolved.voicesUrl, voicesPath, options.fetchImpl ?? fetch, !!options.forceDownload, {
    signal: options.signal,
    retries: options.retries,
    onDownloadProgress: options.onDownloadProgress,
    expectedSha256: options.integrity?.[resolved.rawConfig.voices],
  });

  return {
    ...resolved,
    cacheDir: repoCacheDir,
    configPath,
    modelPath,
    voicesPath,
  };
}
