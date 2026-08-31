export class BrowserKittenTtsWorkerClient {
  static async create({ workerUrl = "/web/browser-worker.mjs", init } = {}) {
    const client = new BrowserKittenTtsWorkerClient(workerUrl);
    if (init) {
      await client.init(init);
    }
    return client;
  }

  constructor(workerUrl = "/web/browser-worker.mjs") {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.nextRequestId = 1;
    this.pending = new Map();
    this.closed = false;
    this.workerError = null;
    this.requestTimeoutMs = 30000;
    this.booted = false;
    this.lastProgress = "worker-created";
    this.bootPromise = new Promise((resolve, reject) => {
      this.resolveBoot = resolve;
      this.rejectBoot = reject;
    });
    this.bootTimeout = setTimeout(() => {
      const error = new Error("worker boot timed out after 15000ms");
      this.workerError = error;
      this.rejectBoot(error);
    }, 15000);

    this.worker.addEventListener("message", (event) => {
      const { id, ok, result, error } = event.data ?? {};
      if (event.data?.type === "boot") {
        this.booted = true;
        this.lastProgress = "worker-booted";
        clearTimeout(this.bootTimeout);
        this.resolveBoot();
        return;
      }
      if (event.data?.type === "progress") {
        this.lastProgress = event.data.phase ?? "unknown-progress";
        return;
      }
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      this.pending.delete(id);
      if (ok) {
        entry.resolve(result);
      } else {
        const workerError = new Error(error?.message ?? "worker request failed");
        if (error?.stack) {
          workerError.stack = error.stack;
        }
        entry.reject(workerError);
      }
    });

    this.worker.addEventListener("error", (event) => {
      const error = event.error ?? new Error(event.message || "worker crashed");
      this.workerError = error;
      clearTimeout(this.bootTimeout);
      this.rejectBoot(error);
      this.#failPending(error);
    });

    this.worker.addEventListener("messageerror", () => {
      const error = new Error("worker message could not be deserialized");
      this.workerError = error;
      clearTimeout(this.bootTimeout);
      this.rejectBoot(error);
      this.#failPending(error);
    });
  }

  async init(options) {
    return this.#request("init", options);
  }

  async synthesize(request) {
    return this.#request("synthesize", request);
  }

  async release() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.#request("dispose", null);
    } catch {
      // Ignore dispose failures, the worker is terminated below either way.
    } finally {
      this.worker.terminate();
      this.#failPending(new Error("worker client released"));
    }
  }

  #request(type, payload) {
    if (this.closed && type !== "dispose") {
      return Promise.reject(new Error("worker client already released"));
    }
    if (this.workerError) {
      return Promise.reject(this.workerError);
    }

    return this.bootPromise.then(
      () =>
        new Promise((resolve, reject) => {
          const id = this.nextRequestId;
          this.nextRequestId += 1;
          const timeout = setTimeout(() => {
            this.pending.delete(id);
            reject(
              new Error(
                `worker request '${type}' timed out after ${this.requestTimeoutMs}ms ` +
                  `(last progress: ${this.lastProgress})`,
              ),
            );
          }, this.requestTimeoutMs);
          this.pending.set(id, {
            resolve: (value) => {
              clearTimeout(timeout);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            },
          });
          this.worker.postMessage({ id, type, payload });
        }),
    );
  }

  #failPending(error) {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }
}
