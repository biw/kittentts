import { fetchWithRetry, type FetchWithRetryOptions } from "../core/fetch-retry.js";
import { readResponseBytes } from "../core/response-bytes.js";

export interface BrowserAssetOptions extends FetchWithRetryOptions {
  cacheName?: string;
  forceDownload?: boolean;
  expectedSha256?: string;
  onProgress?: (loadedBytes: number, totalBytes?: number) => void;
}

export interface BrowserAssetCacheInfo {
  available: boolean;
  cacheName: string;
  entries: string[];
}

export const DEFAULT_BROWSER_ASSET_CACHE = "kittentts-js-v1";

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function assertIntegrity(bytes: Uint8Array, expectedSha256?: string): Promise<void> {
  if (!expectedSha256) return;
  const actual = await sha256(bytes);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`asset integrity check failed: expected ${expectedSha256}, got ${actual}`);
  }
}

function cacheStorage(): CacheStorage | undefined {
  return typeof caches === "undefined" ? undefined : caches;
}

export async function fetchBrowserAsset(url: string, options: BrowserAssetOptions = {}): Promise<Uint8Array> {
  const storage = cacheStorage();
  const cache = storage ? await storage.open(options.cacheName ?? DEFAULT_BROWSER_ASSET_CACHE) : undefined;
  if (!options.forceDownload && cache) {
    const cached = await cache.match(url);
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      try {
        await assertIntegrity(bytes, options.expectedSha256);
        options.onProgress?.(bytes.byteLength, bytes.byteLength);
        return bytes;
      } catch {
        await cache.delete(url);
      }
    }
  }

  const response = await fetchWithRetry(url, options);
  if (!response.ok) throw new Error(`failed to download asset: ${response.status} ${url}`);
  const bytes = await readResponseBytes(response, options);
  options.signal?.throwIfAborted();
  await assertIntegrity(bytes, options.expectedSha256);
  if (cache) {
    await cache.put(url, new Response(bytes.slice().buffer, { headers: { "content-type": "application/octet-stream" } }));
  }
  return bytes;
}

export async function browserAssetCacheInfo(cacheName = DEFAULT_BROWSER_ASSET_CACHE): Promise<BrowserAssetCacheInfo> {
  const storage = cacheStorage();
  if (!storage) return { available: false, cacheName, entries: [] };
  const cache = await storage.open(cacheName);
  return { available: true, cacheName, entries: (await cache.keys()).map((request) => request.url) };
}

export async function clearBrowserAssetCache(cacheName = DEFAULT_BROWSER_ASSET_CACHE): Promise<boolean> {
  const storage = cacheStorage();
  return storage ? storage.delete(cacheName) : false;
}
