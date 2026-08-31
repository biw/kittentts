import { createBrowserKittenTts } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createBrowserKittenTts>> | null = null;
const activeRequests = new Map<number, AbortController>();
type WorkerScopeLike = typeof globalThis & {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<{ id?: number; type?: string; payload?: unknown }>) => void | Promise<void>,
  ): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
  postMessage(message: unknown): void;
};
const workerScope = globalThis as WorkerScopeLike;

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

function audioTransferList(result: { audio: Float32Array; chunks: Array<{ audio: Float32Array }> }): Transferable[] {
  const transfers: Transferable[] = [result.audio.buffer];
  for (const chunk of result.chunks) {
    transfers.push(chunk.audio.buffer);
  }
  return transfers;
}

workerScope.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data ?? {};
  try {
    switch (type) {
      case "init": {
        if (runtime) {
          await runtime.release();
        }
        workerScope.postMessage({ type: "progress", phase: "init-start" });
        runtime = await createBrowserKittenTts({
          ...(payload as Record<string, unknown>),
          onProgress: (phase: string) => workerScope.postMessage({ type: "progress", phase }),
          onDownloadProgress: (asset: string, loadedBytes: number, totalBytes?: number) =>
            workerScope.postMessage({ type: "progress", phase: "asset-download", asset, loadedBytes, totalBytes }),
        });
        workerScope.postMessage({
          id,
          ok: true,
          result: {
            sampleRate: runtime.config.sampleRate,
            executionProviders: [...runtime.executionProviders],
            executionMode: runtime.executionMode,
            numThreads: runtime.numThreads,
            manifestUrl: runtime.manifestUrl,
            modelUrl: runtime.modelUrl,
            voicesUrl: runtime.voicesUrl,
          },
        });
        return;
      }
      case "synthesize": {
        if (!runtime) {
          throw new Error("worker runtime not initialized");
        }
        const controller = new AbortController();
        if (id !== undefined) activeRequests.set(id, controller);
        const result = await runtime.synthesize({ ...(payload as Record<string, unknown>), signal: controller.signal } as never);
        if (id !== undefined) activeRequests.delete(id);
        controller.signal.throwIfAborted();
        workerScope.postMessage({ id, ok: true, result }, audioTransferList(result));
        return;
      }
      case "cancel": {
        if (id !== undefined) activeRequests.get(id)?.abort();
        return;
      }
      case "dispose": {
        if (runtime) {
          await runtime.release();
          runtime = null;
        }
        workerScope.postMessage({ id, ok: true, result: null });
        return;
      }
      default:
        throw new Error(`unsupported worker message '${type}'`);
    }
  } catch (error) {
    if (id !== undefined) activeRequests.delete(id);
    workerScope.postMessage({
      id,
      ok: false,
      error: serializeError(error),
    });
  }
});

workerScope.postMessage({ type: "boot" });
