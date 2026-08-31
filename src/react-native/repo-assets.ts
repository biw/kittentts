import {
  buildKittenTtsRepoFileUrl,
  normalizeKittenTtsRepoReference,
  resolveKittenTtsRepoAssetsFromConfig,
  type KittenTtsRepoReference,
  type ResolvedKittenTtsRepoAssets,
} from "../core/repo-assets.js";
import {
  loadReactNativeFileSystem,
  type ReactNativeDownloadResult,
  type ReactNativeFileSystem,
} from "./types.js";

export interface ReactNativeKittenTtsRepoOptions extends KittenTtsRepoReference {
  cacheDir?: string;
  fileSystem?: ReactNativeFileSystem;
  forceDownload?: boolean;
  signal?: AbortSignal;
  retries?: number;
  integrity?: Record<string, string>;
  onDownloadProgress?: (asset: string, loadedBytes: number, totalBytes?: number) => void;
}

export interface DownloadedReactNativeKittenTtsRepoAssets extends ResolvedKittenTtsRepoAssets {
  cacheDir: string;
  configPath: string;
  modelPath: string;
  voicesPath: string;
}

export interface ReactNativeKittenTtsCacheInfo {
  cacheDir: string;
  exists: boolean;
  files: Array<{ path: string; bytes: number }>;
  totalBytes: number;
}

let temporarySequence = 0;
const downloadsInFlight = new Map<string, Promise<void>>();

export function defaultReactNativeKittenTtsCacheDir(fileSystem: ReactNativeFileSystem): string {
  return joinPath(fileSystem.CachesDirectoryPath, "kittentts-js");
}

function safeRelativePath(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error(`invalid cache path '${value}'`);
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new Error(`invalid cache path segment '${segment}'`);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) => index === 0 ? part.replace(/\/+$/g, "") : part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function dirname(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index <= 0 ? "." : filePath.slice(0, index);
}

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function repoCacheDirectory(options: ReactNativeKittenTtsRepoOptions, fileSystem: ReactNativeFileSystem): string {
  const normalized = normalizeKittenTtsRepoReference(options);
  return joinPath(
    options.cacheDir ?? defaultReactNativeKittenTtsCacheDir(fileSystem),
    safeRelativePath(normalized.repoId),
    safeRelativePath(normalized.revision),
  );
}

async function deleteIfExists(fileSystem: ReactNativeFileSystem, targetPath: string): Promise<void> {
  if (await fileSystem.exists(targetPath)) await fileSystem.unlink(targetPath);
}

async function assertIntegrity(
  fileSystem: ReactNativeFileSystem,
  filePath: string,
  expectedSha256?: string,
): Promise<void> {
  if (!expectedSha256) return;
  const actual = (await fileSystem.hash(filePath, "sha256")).toLowerCase();
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `asset integrity check failed for ${basename(filePath)}: expected ${expectedSha256}, got ${actual}`,
    );
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForDownload(
  fileSystem: ReactNativeFileSystem,
  jobId: number,
  promise: Promise<ReactNativeDownloadResult>,
  signal?: AbortSignal,
): Promise<ReactNativeDownloadResult> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return await new Promise<ReactNativeDownloadResult>((resolve, reject) => {
    const onAbort = () => {
      try { fileSystem.stopDownload(jobId); } catch { /* best-effort native cancellation */ }
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function downloadFile(
  fileSystem: ReactNativeFileSystem,
  url: string,
  destinationPath: string,
  forceDownload: boolean,
  options: Pick<ReactNativeKittenTtsRepoOptions, "signal" | "retries" | "onDownloadProgress"> & {
    expectedSha256?: string;
  },
): Promise<void> {
  if (!forceDownload && await fileSystem.exists(destinationPath)) {
    try {
      await assertIntegrity(fileSystem, destinationPath, options.expectedSha256);
      return;
    } catch {
      await deleteIfExists(fileSystem, destinationPath);
    }
  }

  const existingDownload = downloadsInFlight.get(destinationPath);
  if (existingDownload) return await existingDownload;

  const download = (async () => {
    await fileSystem.mkdir(dirname(destinationPath));
    temporarySequence += 1;
    const temporaryPath = `${destinationPath}.${Date.now()}.${temporarySequence}.download`;
    try {
      const retries = options.retries ?? 2;
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        options.signal?.throwIfAborted();
        await deleteIfExists(fileSystem, temporaryPath);
        let totalBytes: number | undefined;
        try {
          const job = fileSystem.downloadFile({
            fromUrl: url,
            toFile: temporaryPath,
            cacheable: false,
            progressInterval: 100,
            connectionTimeout: 30_000,
            readTimeout: 30_000,
            backgroundTimeout: 10 * 60_000,
            begin: (result) => {
              totalBytes = result.contentLength > 0 ? result.contentLength : undefined;
            },
            progress: (result) => {
              const total = result.contentLength > 0 ? result.contentLength : totalBytes;
              options.onDownloadProgress?.(basename(destinationPath), result.bytesWritten, total);
            },
          });
          const result = await waitForDownload(fileSystem, job.jobId, job.promise, options.signal);
          if (result.statusCode < 200 || result.statusCode >= 300) {
            throw new Error(`failed to download asset: ${result.statusCode} ${url}`);
          }
          options.onDownloadProgress?.(basename(destinationPath), result.bytesWritten, totalBytes);
          options.signal?.throwIfAborted();
          await assertIntegrity(fileSystem, temporaryPath, options.expectedSha256);
          if (forceDownload) await deleteIfExists(fileSystem, destinationPath);
          await fileSystem.moveFile(temporaryPath, destinationPath);
          return;
        } catch (error) {
          lastError = error;
          await deleteIfExists(fileSystem, temporaryPath);
          if (options.signal?.aborted) throw options.signal.reason ?? error;
          if (attempt < retries) await abortableDelay(250 * 2 ** attempt, options.signal);
        }
      }
      throw lastError ?? new Error(`failed to download asset: ${url}`);
    } finally {
      await deleteIfExists(fileSystem, temporaryPath);
    }
  })();

  downloadsInFlight.set(destinationPath, download);
  try {
    await download;
  } finally {
    if (downloadsInFlight.get(destinationPath) === download) downloadsInFlight.delete(destinationPath);
  }
}

async function resolveFileSystem(options: ReactNativeKittenTtsRepoOptions): Promise<ReactNativeFileSystem> {
  return options.fileSystem ?? await loadReactNativeFileSystem();
}

export async function downloadReactNativeKittenTtsRepoAssets(
  options: ReactNativeKittenTtsRepoOptions,
): Promise<DownloadedReactNativeKittenTtsRepoAssets> {
  const fileSystem = await resolveFileSystem(options);
  const normalized = normalizeKittenTtsRepoReference(options);
  const repoCacheDir = repoCacheDirectory(options, fileSystem);
  const configPath = joinPath(repoCacheDir, safeRelativePath(normalized.configFilename));
  let resolved: ResolvedKittenTtsRepoAssets | undefined;

  if (!options.forceDownload && await fileSystem.exists(configPath)) {
    try {
      await assertIntegrity(fileSystem, configPath, options.integrity?.[normalized.configFilename]);
      resolved = resolveKittenTtsRepoAssetsFromConfig(
        normalized,
        JSON.parse(await fileSystem.readFile(configPath, "utf8")),
      );
    } catch {
      await deleteIfExists(fileSystem, configPath);
    }
  }

  if (!resolved) {
    await downloadFile(
      fileSystem,
      buildKittenTtsRepoFileUrl(normalized, normalized.configFilename),
      configPath,
      !!options.forceDownload,
      {
        signal: options.signal,
        retries: options.retries,
        onDownloadProgress: options.onDownloadProgress,
        expectedSha256: options.integrity?.[normalized.configFilename],
      },
    );
    try {
      resolved = resolveKittenTtsRepoAssetsFromConfig(
        normalized,
        JSON.parse(await fileSystem.readFile(configPath, "utf8")),
      );
    } catch (error) {
      await deleteIfExists(fileSystem, configPath);
      throw error;
    }
  }

  options.signal?.throwIfAborted();
  const modelPath = joinPath(repoCacheDir, safeRelativePath(resolved.rawConfig.model_file));
  const voicesPath = joinPath(repoCacheDir, safeRelativePath(resolved.rawConfig.voices));
  await downloadFile(fileSystem, resolved.modelUrl, modelPath, !!options.forceDownload, {
    signal: options.signal,
    retries: options.retries,
    onDownloadProgress: options.onDownloadProgress,
    expectedSha256: options.integrity?.[resolved.rawConfig.model_file],
  });
  await downloadFile(fileSystem, resolved.voicesUrl, voicesPath, !!options.forceDownload, {
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

export async function reactNativeKittenTtsCacheInfo(
  options: ReactNativeKittenTtsRepoOptions,
): Promise<ReactNativeKittenTtsCacheInfo> {
  const fileSystem = await resolveFileSystem(options);
  const cacheDir = repoCacheDirectory(options, fileSystem);
  if (!await fileSystem.exists(cacheDir)) return { cacheDir, exists: false, files: [], totalBytes: 0 };
  const files: Array<{ path: string; bytes: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fileSystem.readDir(directory)) {
      const entryPath = entry.path ?? joinPath(directory, entry.name ?? "");
      if (entry.isDirectory?.()) await visit(entryPath);
      else if (entry.isFile?.() ?? true) {
        files.push({ path: entryPath.slice(cacheDir.length + 1), bytes: Number(entry.size) });
      }
    }
  };
  await visit(cacheDir);
  return { cacheDir, exists: true, files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

export async function clearReactNativeKittenTtsCache(
  options: ReactNativeKittenTtsRepoOptions,
): Promise<boolean> {
  const fileSystem = await resolveFileSystem(options);
  const cacheDir = repoCacheDirectory(options, fileSystem);
  const existed = await fileSystem.exists(cacheDir);
  if (existed) await fileSystem.unlink(cacheDir);
  return existed;
}
