import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { encodeWav } from "../src/audio/index.js";
import {
  audioSignatureDeltas,
  tokenizePhonemes,
  summarizeAudioSignature,
} from "../src/core/phoneme-feeds.js";
import { PhonemizerJsPhonemizer } from "../src/core/phonemizer.js";
import { buildPipelineFeeds } from "../src/core/pipeline.js";
import {
  buildKittenTtsRepoFileUrl,
  resolveKittenTtsRepoAssets,
} from "../src/core/repo-assets.js";
import {
  chunkText,
  expandDecades,
  expandFractions,
  expandIpAddresses,
  expandOrdinals,
  expandPhoneNumbers,
  expandScientificNotation,
  expandUnits,
} from "../src/core/text-preprocess.js";
import { loadVoicesNpz, selectStyleRow } from "../src/core/voices-npz.js";
import { downloadNodeKittenTtsRepoAssets } from "../src/node/repo-assets.js";
import { BrowserKittenTtsWorkerClient } from "../src/browser/worker-client.js";
import { joinAudio } from "../src/audio/join.js";
import { encodeMp3 } from "../src/audio/mp3.js";
import type { KittenTtsBackend } from "../src/sdk/contracts.js";
import { KITTENTTS_MODELS, resolveKittenTtsModel } from "../src/sdk/model-registry.js";
import { KittenTtsResult } from "../src/sdk/result.js";
import { KittenTtsSession } from "../src/sdk/session.js";
import { collectKittenTtsStream } from "../src/sdk/stream.js";
import { createHash } from "node:crypto";
import { clearNodeKittenTtsCache, nodeKittenTtsCacheInfo } from "../src/node/repo-assets.js";
import { fetchBrowserAsset } from "../src/browser/asset-cache.js";

test("specialized text normalization matches reference behavior", () => {
  assert.equal(expandOrdinals("1st 2nd 3rd 21st 100th"), "first second third twenty-first one hundredth");
  assert.equal(expandScientificNotation("1e-4 and 2.5E10"), "one times ten to the negative four and two point five times ten to the ten");
  assert.equal(expandUnits("2.5kg 12km 23°C"), "two point five kilograms twelve kilometers twenty-three degrees Celsius");
  assert.equal(expandFractions("1/2 3/4 2/3"), "one half three quarters two thirds");
  assert.equal(expandDecades("80s 1990s"), "eighties nineteen nineties");
  assert.equal(expandIpAddresses("192.168.1.1"), "one nine two dot one six eight dot one dot one");
  assert.equal(expandPhoneNumbers("555-1234 555-123-4567"), "five five five one two three four five five five one two three four five six seven");
});

test("chunking preserves terminal punctuation and abbreviations", () => {
  assert.deepEqual(chunkText("Dr. Smith arrived at 3.14 p.m. Tomorrow starts early."), [
    "Dr. Smith arrived at 3.14 p.m.",
    "Tomorrow starts early.",
  ]);
  assert.deepEqual(chunkText("No terminal punctuation"), ["No terminal punctuation,"]);
});

test("phonemizer preserves punctuation embedded in abbreviations", async () => {
  const phonemizer = new PhonemizerJsPhonemizer();
  assert.equal(
    await phonemizer.phonemize("email before ten thirtya.m."),
    "ˈiːmeɪl bᵻfˌɔːɹ tˈɛn θˈɜːɾɪə.ˈɛm. ",
  );
});

test("phoneme tokenization matches Python for combining IPA marks", () => {
  assert.equal(tokenizePhonemes("kˈɪʔn̩ tˌiː"), "kˈɪʔn ̩ tˌiː");
});

test("repo resolution rejects HTTP and malformed configuration errors", async () => {
  await assert.rejects(
    resolveKittenTtsRepoAssets(
      { repoId: "KittenML/test" },
      async () => new Response("unavailable", { status: 503 }),
    ),
    /failed to load repo config: 503/,
  );
  await assert.rejects(
    resolveKittenTtsRepoAssets(
      { repoId: "KittenML/test" },
      async () => Response.json({ type: "ONNX2", voices: "voices.npz" }),
    ),
    /missing 'model_file'/,
  );
  await assert.rejects(
    resolveKittenTtsRepoAssets(
      { repoId: "KittenML/test" },
      async () => Response.json({ type: "pytorch", model_file: "model.bin", voices: "voices.npz" }),
    ),
    /unsupported repo config type/,
  );
  assert.throws(
    () => buildKittenTtsRepoFileUrl({ repoId: "KittenML/test" }, "../model.onnx"),
    /invalid repository path segment/,
  );
});

test("failed asset downloads do not leave partial cache files", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "kittentts-download-error-"));
  try {
    await assert.rejects(
      downloadNodeKittenTtsRepoAssets({
        repoId: "KittenML/test",
        cacheDir,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("config.json")) {
            return Response.json({ type: "ONNX2", model_file: "model.onnx", voices: "voices.npz" });
          }
          return new Response("unavailable", { status: 503 });
        },
      }),
      /failed to download asset: 503/,
    );
    const entries = await fs.readdir(cacheDir, { recursive: true });
    assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("voice archive and selection validation reject malformed inputs", () => {
  assert.throws(() => loadVoicesNpz(Uint8Array.from([1, 2, 3, 4])), /invalid|unknown|zip/i);
  assert.deepEqual(selectStyleRow({ shape: [2, 3], data: Float32Array.from([1, 2, 3, 4, 5, 6]) }, 99), {
    refId: 1,
    styleShape: [1, 3],
    style: Float32Array.from([4, 5, 6]),
  });
});

test("pipeline reports an invalid voice before phonemization", async () => {
  await assert.rejects(
    buildPipelineFeeds({
      text: "hello",
      voice: "missing",
      speed: 1,
      cleanText: false,
      phonemizer: { phonemize: async () => "həlˈoʊ" },
      voices: {},
    }),
    /missing voice matrix/,
  );
  await assert.rejects(
    buildPipelineFeeds({
      text: "   ",
      voice: "Bruno",
      speed: 1,
      cleanText: false,
      phonemizer: { phonemize: async () => "" },
      voices: {},
    }),
    /text must contain/,
  );
  await assert.rejects(
    buildPipelineFeeds({
      text: "hello",
      voice: "Bruno",
      speed: Number.NaN,
      cleanText: false,
      phonemizer: { phonemize: async () => "" },
      voices: {},
    }),
    /speed must be a finite number greater than zero/,
  );
});

test("audio signatures detect envelope and frequency changes", () => {
  const silence = summarizeAudioSignature(new Float32Array(320));
  const alternating = summarizeAudioSignature(Float32Array.from({ length: 320 }, (_, index) => index % 2 ? 0.5 : -0.5));
  const deltas = audioSignatureDeltas(alternating, silence);
  assert.ok(deltas.rms > 0.4);
  assert.ok(deltas.deltaRms > 0.9);
  assert.ok(deltas.zeroCrossingRate > 0.9);
});

test("WAV encoder writes valid PCM16 and float32 headers", () => {
  const pcm = encodeWav([-2, -1, 0, 1, 2], { sampleRate: 24000 });
  const pcmView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  assert.equal(new TextDecoder().decode(pcm.slice(0, 4)), "RIFF");
  assert.equal(pcmView.getUint16(20, true), 1);
  assert.equal(pcmView.getUint32(24, true), 24000);
  assert.equal(pcmView.getInt16(44, true), -32768);
  assert.equal(pcmView.getInt16(52, true), 32767);

  const float = encodeWav([0.25], { sampleRate: 16000, format: "float32" });
  const floatView = new DataView(float.buffer, float.byteOffset, float.byteLength);
  assert.equal(floatView.getUint16(20, true), 3);
  assert.equal(floatView.getFloat32(44, true), 0.25);
  assert.throws(() => encodeWav([], { sampleRate: 0 }), /sampleRate must be a positive integer/);
  assert.throws(
    () => encodeWav([], { sampleRate: 24000, format: "mulaw" as "pcm16" }),
    /unsupported WAV format/,
  );
});

test("worker client handles boot, concurrent requests, and idempotent release", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");

  class FakeWorker extends EventTarget {
    static latest: FakeWorker | undefined;
    terminated = 0;
    messages: Array<{ id: number; type: string; payload: unknown }> = [];

    constructor() {
      super();
      FakeWorker.latest = this;
      setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: { type: "boot" } })), 0);
    }

    postMessage(message: { id: number; type: string; payload: unknown }) {
      this.messages.push(message);
      if (message.type === "cancel" || (message.type === "synthesize" && (message.payload as { text?: string })?.text === "slow")) return;
      const result = message.type === "synthesize" ? { request: message.payload } : undefined;
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, ok: true, result } }));
      });
    }

    terminate() {
      this.terminated += 1;
    }
  }

  Object.defineProperty(globalThis, "self", { value: globalThis, configurable: true });
  Object.defineProperty(globalThis, "Worker", { value: FakeWorker, configurable: true });
  try {
    const client = await BrowserKittenTtsWorkerClient.create({ init: { modelUrl: "model.onnx" } });
    const [first, second] = await Promise.all([
      client.synthesize<{ request: unknown }>({ text: "one" }),
      client.synthesize<{ request: unknown }>({ text: "two" }),
    ]);
    assert.deepEqual(first, { request: { text: "one" } });
    assert.deepEqual(second, { request: { text: "two" } });
    const controller = new AbortController();
    const slow = client.synthesize({ text: "slow" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(slow, /cancelled/);
    assert.equal(FakeWorker.latest?.messages.some((message) => message.type === "cancel"), true);
    await client.release();
    await client.release();
    await assert.rejects(client.synthesize({ text: "closed" }), /already released/);
  } finally {
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    if (originalSelf) Object.defineProperty(globalThis, "self", originalSelf);
    else Reflect.deleteProperty(globalThis, "self");
  }
});

function createFakeBackend(): KittenTtsBackend & { calls: string[]; releases: number } {
  return {
    calls: [],
    releases: 0,
    capabilities: {
      runtime: "node",
      model: "nano",
      transport: "direct",
      executionMode: "native",
      executionProviders: ["cpu"],
      worker: false,
      webGpu: false,
      wasm: false,
      native: true,
      crossOriginIsolated: false,
      threads: 1,
    },
    async synthesize(request) {
      request.signal?.throwIfAborted();
      this.calls.push(request.text);
      const audio = Float32Array.from([0, 0.25, -0.25, 0]);
      return {
        sampleRate: 4,
        executionProviders: ["cpu"],
        cleanedText: request.text,
        chunks: [{
          text: request.text,
          resolvedVoice: request.voice,
          effectiveSpeed: request.speed,
          phonemesRaw: "ab",
          inputIds: [0, 1, 2, 0],
          refId: 0,
          styleShape: [1, 1],
          style: Float32Array.of(0),
          durations: [1, 2, 1, 0],
          audio,
        }],
        audio,
      };
    },
    async release() { this.releases += 1; },
  };
}

test("unified session exposes capabilities, timings, streaming backpressure, and disposal", async () => {
  const backend = createFakeBackend();
  const session = new KittenTtsSession(backend, { model: "nano", defaultVoice: "Bruno" });
  assert.deepEqual(session.capabilities().executionProviders, ["cpu"]);
  const result = await session.generate("Hello", { cleanText: false });
  assert.equal(result.durationSeconds, 1);
  assert.deepEqual(result.tokenTimings.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds]), [
    [0, 0.25], [0.25, 0.75], [0.75, 1], [1, 1],
  ]);

  const stream = session.generateStream("First sentence. Second sentence.", { cleanText: false });
  assert.equal(backend.calls.length, 1);
  const first = await stream.next();
  assert.equal(first.value?.text, "First sentence.");
  assert.equal(backend.calls.length, 2);
  const collected = await collectKittenTtsStream({
    async *[Symbol.asyncIterator]() {
      if (!first.done) yield first.value;
      for await (const chunk of stream) yield chunk;
    },
  }, { crossfadeMs: 250 });
  assert.equal(collected.audio.length, 7);

  await session.dispose();
  await session.dispose();
  assert.equal(backend.releases, 1);
  await assert.rejects(session.generate("closed"), /disposed/);
});

test("unified session rejects aborted work before invoking its backend", async () => {
  const backend = createFakeBackend();
  const session = new KittenTtsSession(backend, { model: "nano" });
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(session.generate("hello", { signal: controller.signal }), /cancelled/);
  assert.equal(backend.calls.length, 0);
  await session.dispose();
});

test("model registry pins every supported model and asset digest", () => {
  assert.deepEqual(Object.keys(KITTENTTS_MODELS), ["nano", "nano-int8", "micro", "mini"]);
  for (const definition of Object.values(KITTENTTS_MODELS)) {
    assert.match(definition.revision, /^[0-9a-f]{40}$/);
    assert.match(definition.modelSha256, /^[0-9a-f]{64}$/);
    assert.match(definition.voicesSha256, /^[0-9a-f]{64}$/);
    assert.match(definition.configSha256, /^[0-9a-f]{64}$/);
  }
  assert.throws(() => resolveKittenTtsModel("large" as "nano"), /unsupported/);
});

test("audio joining crossfades boundaries without changing endpoints", () => {
  assert.deepEqual(Array.from(joinAudio([Float32Array.of(1, 1), Float32Array.of(-1, -1)], 1)), [1, 0, -1]);
  assert.throws(() => joinAudio([], -1), /non-negative integer/);
});

test("MP3 encoder produces MPEG audio without requiring a system codec", async () => {
  const samples = Float32Array.from({ length: 2400 }, (_, index) => Math.sin(index * Math.PI / 12) * 0.1);
  const mp3 = await encodeMp3(samples, { sampleRate: 24000, bitrate: 64 });
  assert.ok(mp3.byteLength > 100);
  assert.ok(
    new TextDecoder().decode(mp3.subarray(0, 3)) === "ID3" || (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0),
    "expected an ID3 tag or MPEG frame sync",
  );
});

test("Node cache supports offline reuse, inspection, clearing, and corrupt-file recovery", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "kittentts-cache-"));
  const config = new TextEncoder().encode('{"type":"ONNX2","model_file":"model.onnx","voices":"voices.npz"}\n');
  const model = Uint8Array.from([1, 2, 3]);
  const voices = Uint8Array.from([4, 5, 6]);
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const integrity = {
    "config.json": digest(config),
    "model.onnx": digest(model),
    "voices.npz": digest(voices),
  };
  const reference = { repoId: "KittenML/cache-test", revision: "abc", cacheDir };
  let fetches = 0;
  const onlineFetch = async (input: string | URL) => {
    fetches += 1;
    const url = String(input);
    if (url.endsWith("config.json")) return new Response(config);
    if (url.endsWith("model.onnx")) return new Response(model);
    return new Response(voices);
  };
  try {
    const first = await downloadNodeKittenTtsRepoAssets({
      ...reference,
      fetchImpl: onlineFetch,
      integrity,
    });
    assert.equal(fetches, 3);
    const offline = await downloadNodeKittenTtsRepoAssets({
      ...reference,
      fetchImpl: async () => { throw new Error("network must not be used"); },
      integrity,
    });
    assert.equal(offline.modelPath, first.modelPath);
    const info = await nodeKittenTtsCacheInfo(reference);
    assert.equal(info.files.length, 3);
    assert.equal(info.totalBytes > 0, true);

    await fs.writeFile(first.modelPath, "corrupt");
    let recoveryFetches = 0;
    await downloadNodeKittenTtsRepoAssets({
      ...reference,
      fetchImpl: async (input) => {
        recoveryFetches += 1;
        assert.match(String(input), /model\.onnx$/);
        return new Response(model);
      },
      integrity,
    });
    assert.equal(recoveryFetches, 1);

    await fs.writeFile(first.configPath, "corrupt");
    let configRecoveryFetches = 0;
    await downloadNodeKittenTtsRepoAssets({
      ...reference,
      fetchImpl: async (input) => {
        configRecoveryFetches += 1;
        assert.match(String(input), /config\.json$/);
        return new Response(config);
      },
      integrity,
    });
    assert.equal(configRecoveryFetches, 1);
    assert.equal(await clearNodeKittenTtsCache(reference), true);
    assert.equal((await nodeKittenTtsCacheInfo(reference)).exists, false);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("browser asset loader retries transient failures and enforces integrity without Cache API", async () => {
  const bytes = Uint8Array.from([9, 8, 7]);
  const expected = createHash("sha256").update(bytes).digest("hex");
  let attempts = 0;
  const loaded = await fetchBrowserAsset("https://example.test/model.onnx", {
    retries: 1,
    retryDelayMs: 0,
    expectedSha256: expected,
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1 ? new Response("retry", { status: 503 }) : new Response(bytes);
    },
  });
  assert.deepEqual(loaded, bytes);
  assert.equal(attempts, 2);
  await assert.rejects(
    fetchBrowserAsset("https://example.test/bad.onnx", {
      expectedSha256: "0".repeat(64),
      fetchImpl: async () => new Response(bytes),
    }),
    /integrity check failed/,
  );
});

test("browser facade is safe to import during server-side rendering", async () => {
  const module = await import("../src/sdk/browser-entry.js");
  assert.equal(typeof module.KittenTTS.create, "function");
});
