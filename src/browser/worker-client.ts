export interface BrowserWorkerRuntimeInfo {
  sampleRate: number;
  executionProviders: string[];
  executionMode: "auto" | "wasm" | "webgpu";
  numThreads: number;
  manifestUrl?: string;
  modelUrl: string;
  voicesUrl: string;
}

export interface BrowserKittenTtsWorkerClientOptions {
  workerUrl?: URL | string;
  init?: unknown;
  requestTimeoutMs?: number;
  onProgress?: (phase: string, details?: { asset?: string; loadedBytes?: number; totalBytes?: number }) => void;
  signal?: AbortSignal;
}

export class BrowserKittenTtsWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #requestTimeoutMs: number;
  readonly #onProgress?: BrowserKittenTtsWorkerClientOptions["onProgress"];
  readonly #bootPromise: Promise<void>;
  #resolveBoot!: () => void;
  #rejectBoot!: (error: Error) => void;
  #bootTimeout: number;
  #nextRequestId = 1;
  #closed = false;
  #workerError: Error | null = null;
  #lastProgress = "worker-created";
  #runtimeInfo?: BrowserWorkerRuntimeInfo;

  static async create(options: BrowserKittenTtsWorkerClientOptions = {}): Promise<BrowserKittenTtsWorkerClient> {
    const client = new BrowserKittenTtsWorkerClient(options.workerUrl, options);
    if (options.init) {
      try {
        client.#runtimeInfo = await client.init<BrowserWorkerRuntimeInfo>(options.init, options.signal);
      } catch (error) {
        await client.release();
        throw error;
      }
    }
    return client;
  }

  constructor(
    workerUrl: URL | string = new URL("./browser/worker.js", import.meta.url),
    options: Omit<BrowserKittenTtsWorkerClientOptions, "workerUrl" | "init" | "signal"> = {},
  ) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#onProgress = options.onProgress;
    this.#bootPromise = new Promise<void>((resolve, reject) => {
      this.#resolveBoot = resolve;
      this.#rejectBoot = (error: Error) => reject(error);
    });
    this.#worker = new Worker(workerUrl, { type: "module" });
    this.#bootTimeout = self.setTimeout(() => {
      const error = new Error("worker boot timed out after 15000ms");
      this.#workerError = error;
      this.#rejectBoot(error);
    }, 15000);

    this.#worker.addEventListener("message", (event) => {
      const payload = event.data as { id?: number; ok?: boolean; result?: unknown; error?: { message?: string; stack?: string }; type?: string; phase?: string; asset?: string; loadedBytes?: number; totalBytes?: number };
      if (payload.type === "boot") {
        this.#lastProgress = "worker-booted";
        self.clearTimeout(this.#bootTimeout);
        this.#resolveBoot();
        return;
      }
      if (payload.type === "progress") {
        this.#lastProgress = payload.phase ?? "unknown-progress";
        this.#onProgress?.(this.#lastProgress, payload);
        return;
      }

      const id = payload.id;
      if (id === undefined) {
        return;
      }
      const entry = this.#pending.get(id);
      if (!entry) {
        return;
      }
      this.#pending.delete(id);
      if (payload.ok) {
        entry.resolve(payload.result);
      } else {
        const error = new Error(payload.error?.message ?? "worker request failed");
        if (payload.error?.stack) {
          error.stack = payload.error.stack;
        }
        entry.reject(error);
      }
    });

    this.#worker.addEventListener("error", (event) => {
      const error =
        event.error instanceof Error
          ? event.error
          : new Error(
              [
                event.message || "worker crashed",
                event.filename ? `at ${event.filename}` : null,
                typeof event.lineno === "number" && event.lineno > 0 ? `line ${event.lineno}` : null,
                typeof event.colno === "number" && event.colno > 0 ? `column ${event.colno}` : null,
              ]
                .filter(Boolean)
                .join(" "),
            );
      this.#workerError = error;
      self.clearTimeout(this.#bootTimeout);
      this.#rejectBoot(error);
      this.#failPending(error);
    });

    this.#worker.addEventListener("messageerror", () => {
      const error = new Error("worker message could not be deserialized");
      this.#workerError = error;
      self.clearTimeout(this.#bootTimeout);
      this.#rejectBoot(error);
      this.#failPending(error);
    });
  }

  async init<T>(options: unknown, signal?: AbortSignal): Promise<T> {
    const info = await this.#request("init", options, signal) as T;
    this.#runtimeInfo = info as BrowserWorkerRuntimeInfo;
    return info;
  }

  get runtimeInfo(): BrowserWorkerRuntimeInfo | undefined {
    return this.#runtimeInfo ? { ...this.#runtimeInfo, executionProviders: [...this.#runtimeInfo.executionProviders] } : undefined;
  }

  async synthesize<T>(request: unknown, signal?: AbortSignal): Promise<T> {
    return this.#request("synthesize", request, signal) as Promise<T>;
  }

  async release(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#request("dispose", null);
    } catch {
      // Ignore dispose failures. The worker is terminated below either way.
    } finally {
      this.#worker.terminate();
      this.#failPending(new Error("worker client released"));
    }
  }

  #request(type: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed && type !== "dispose") {
      return Promise.reject(new Error("worker client already released"));
    }
    if (this.#workerError) {
      return Promise.reject(this.#workerError);
    }
    signal?.throwIfAborted();

    return this.#bootPromise.then(
      () => {
        signal?.throwIfAborted();
        return new Promise<unknown>((resolve, reject) => {
          const id = this.#nextRequestId;
          this.#nextRequestId += 1;
          const onAbort = () => {
            this.#pending.delete(id);
            self.clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
            this.#worker.postMessage({ id, type: "cancel", payload: null });
            reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
          };
          const timeout = self.setTimeout(() => {
            this.#pending.delete(id);
            signal?.removeEventListener("abort", onAbort);
            reject(
              new Error(
                `worker request '${type}' timed out after ${this.#requestTimeoutMs}ms ` +
                  `(last progress: ${this.#lastProgress})`,
              ),
            );
          }, this.#requestTimeoutMs);
          this.#pending.set(id, {
            resolve: (value) => {
              self.clearTimeout(timeout);
              signal?.removeEventListener("abort", onAbort);
              resolve(value);
            },
            reject: (error) => {
              self.clearTimeout(timeout);
              signal?.removeEventListener("abort", onAbort);
              reject(error);
            },
          });
          signal?.addEventListener("abort", onAbort, { once: true });
          this.#worker.postMessage({ id, type, payload });
        });
      },
    );
  }

  #failPending(error: Error): void {
    for (const entry of this.#pending.values()) {
      entry.reject(error);
    }
    this.#pending.clear();
  }
}
