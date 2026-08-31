import type { FetchLike } from "./repo-assets.js";

export interface FetchWithRetryOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  retries?: number;
  retryDelayMs?: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
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

export async function fetchWithRetry(url: string, options: FetchWithRetryOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      const response = await fetchImpl(url, { signal: options.signal });
      if (response.ok || !isRetryableStatus(response.status) || attempt === retries) return response;
      lastError = new Error(`request failed: ${response.status} ${url}`);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt === retries) throw error;
    }
    await delay((options.retryDelayMs ?? 250) * 2 ** attempt, options.signal);
  }
  throw lastError;
}
