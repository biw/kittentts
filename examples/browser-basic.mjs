import {
  KittenTTS,
  runtimeConfigFromManifest,
} from "../dist/sdk/browser-entry.js";

const form = document.querySelector("#synthesis-form");
const textInput = document.querySelector("#text-input");
const voiceInput = document.querySelector("#voice-input");
const speedInput = document.querySelector("#speed-input");
const button = document.querySelector("#synthesize-button");
const statusChip = document.querySelector("#status-chip");
const resultJson = document.querySelector("#result-json");
const audioPlayer = document.querySelector("#audio-player");
const downloadLink = document.querySelector("#download-link");
const params = new URLSearchParams(window.location.search);
const executionMode = ["wasm", "webgpu"].includes(params.get("execution")) ? params.get("execution") : "auto";
const transport = params.get("transport") === "worker" ? "worker" : "main";
const requestedThreads = Number.parseInt(params.get("threads") ?? "", 10);
const numThreads = Number.isInteger(requestedThreads) && requestedThreads > 0 ? requestedThreads : undefined;
const repoId = params.get("repo");
const repoBaseUrl = params.get("repoBaseUrl") ?? undefined;
const ortModuleUrls = {
  wasm: "/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs",
  webgpu: "/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs",
};

let runtimePromise;
let audioUrl = null;

function setStatus(status) {
  statusChip.textContent = status;
}

function setResult(payload) {
  resultJson.textContent = JSON.stringify(payload, null, 2);
}

window.addEventListener("error", (event) => {
  setStatus("script-error");
  setResult({ status: "script-error", message: event.message, filename: event.filename });
});

window.addEventListener("unhandledrejection", (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  setStatus("promise-error");
  setResult({ status: "promise-error", message, stack: event.reason instanceof Error ? event.reason.stack : undefined });
});

function releaseAudioUrl() {
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
}

async function getRuntime() {
  runtimePromise ??= (async () => {
    const sharedOptions = {
      transport: transport === "worker" ? "worker" : "direct",
      executionMode,
      ortModuleUrls,
      numThreads,
      onProgress: (event) => {
        setStatus(`runtime:${event.phase}`);
        setResult({
          status: "starting",
          phase: `runtime:${event.phase}`,
          progress: event.progress,
          transport,
        });
      },
    };

    if (repoId) {
      return KittenTTS.create({
        ...sharedOptions,
        repoId,
        repoBaseUrl,
      });
    }

    const manifestUrl = new URL("/.context/reference-fixtures/manifest.json", window.location.href).toString();
    const manifest = await fetch(manifestUrl).then((response) => response.json());
    return KittenTTS.create({
      ...sharedOptions,
      modelUrl: new URL(manifest.model_asset_path, manifestUrl).toString(),
      voicesUrl: new URL(manifest.voices_asset_path, manifestUrl).toString(),
      config: runtimeConfigFromManifest(manifest),
    });
  })();
  return runtimePromise;
}

async function releaseRuntime() {
  if (!runtimePromise) {
    return;
  }
  try {
    const runtime = await runtimePromise;
    await runtime.release?.();
  } finally {
    runtimePromise = null;
  }
}

async function synthesizeCurrentForm() {
  button.disabled = true;
  downloadLink.hidden = true;
  setStatus("runtime:starting");
  setResult({ status: "starting", transport });

  try {
    const runtime = await getRuntime();
    setStatus("synthesis:running");
    setResult({
      status: "starting",
      phase: "synthesis:running",
      transport,
    });
    const result = await runtime.generate(textInput.value, {
      voice: voiceInput.value,
      speed: Number(speedInput.value || "1"),
      cleanText: true,
    });
    const wavBytes = result.wavData();
    releaseAudioUrl();
    audioUrl = URL.createObjectURL(new Blob([wavBytes], { type: "audio/wav" }));
    audioPlayer.src = audioUrl;
    downloadLink.href = audioUrl;
    downloadLink.hidden = false;
    setStatus("pass");
    setResult({
      status: "pass",
      transport,
      sampleRate: result.sampleRate,
      executionMode: runtime.capabilities().executionMode,
      executionProviders: result.executionProviders,
      threads: runtime.capabilities().threads,
      model: runtime.model,
      cleanedText: result.cleanedText,
      chunks: result.chunks.length,
      samples: result.audio.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus("fail");
    setResult({ status: "fail", transport, error: message });
    throw error;
  } finally {
    button.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await synthesizeCurrentForm();
  } catch (error) {
    console.error(error);
  }
});

window.addEventListener("beforeunload", () => {
  releaseRuntime().catch(() => {});
  releaseAudioUrl();
});

if (params.get("autorun") === "1") {
  synthesizeCurrentForm().catch((error) => {
    console.error(error);
  });
}
