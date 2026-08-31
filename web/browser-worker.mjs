import { createBrowserKittenTts } from "/web/browser-runtime.mjs";

let runtime = null;

function serializeError(error) {
  return {
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
}

function audioTransferList(result) {
  const transfers = [result.audio.buffer];
  for (const chunk of result.chunks) {
    transfers.push(chunk.audio.buffer);
  }
  return transfers;
}

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data ?? {};
  try {
    switch (type) {
      case "init": {
        if (runtime) {
          await runtime.release();
        }
        self.postMessage({ type: "progress", phase: "init-start" });
        runtime = await createBrowserKittenTts({
          ...payload,
          onProgress: (phase) => self.postMessage({ type: "progress", phase }),
        });
        self.postMessage({
          id,
          ok: true,
          result: {
            sampleRate: runtime.manifest.sample_rate,
            executionProviders: [...runtime.executionProviders],
            executionMode: runtime.executionMode,
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
        const result = await runtime.synthesize(payload);
        self.postMessage({ id, ok: true, result }, audioTransferList(result));
        return;
      }
      case "dispose": {
        if (runtime) {
          await runtime.release();
          runtime = null;
        }
        self.postMessage({ id, ok: true, result: null });
        return;
      }
      default:
        throw new Error(`unsupported worker message '${type}'`);
    }
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: serializeError(error),
    });
  }
});

self.postMessage({ type: "boot" });
