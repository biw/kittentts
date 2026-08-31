import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { zipSync } from "fflate";
import { base64ToUint8Array, uint8ArrayToBase64 } from "../src/audio/base64.js";
import { loadVoicesNpz } from "../src/core/voices-npz.js";
import {
  clearReactNativeKittenTtsCache,
  downloadReactNativeKittenTtsRepoAssets,
  reactNativeKittenTtsCacheInfo,
} from "../src/react-native/repo-assets.js";
import {
  createReactNativeFileAudioPlayer,
  createReactNativeSoundPlayer,
} from "../src/react-native/playback.js";
import { createReactNativeCePhonemizer } from "../src/react-native/phonemizer.js";
import { createReactNativeKittenTts } from "../src/react-native/runtime.js";
import type {
  ReactNativeDownloadJob,
  ReactNativeFileStat,
  ReactNativeFileSystem,
  ReactNativeOrtModule,
  ReactNativeOrtSession,
  ReactNativeOrtTensor,
} from "../src/react-native/types.js";

class MemoryReactNativeFileSystem implements ReactNativeFileSystem {
  readonly CachesDirectoryPath = "/cache";
  readonly DocumentDirectoryPath = "/documents";
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>(["/", "/cache", "/documents"]);
  readonly downloads: string[] = [];
  readonly stoppedDownloads: number[] = [];
  readonly routes = new Map<string, { statusCode: number; bytes: Uint8Array }>();
  #nextJobId = 1;

  async exists(targetPath: string): Promise<boolean> {
    return this.files.has(targetPath) || this.directories.has(targetPath);
  }

  async mkdir(targetPath: string): Promise<void> {
    let current = "";
    for (const segment of targetPath.split("/").filter(Boolean)) {
      current += `/${segment}`;
      this.directories.add(current);
    }
  }

  async readFile(targetPath: string, encoding: "utf8" | "base64" = "utf8"): Promise<string> {
    const bytes = this.files.get(targetPath);
    if (!bytes) throw new Error(`ENOENT: ${targetPath}`);
    return encoding === "base64" ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes);
  }

  async writeFile(targetPath: string, contents: string, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    await this.mkdir(targetPath.slice(0, targetPath.lastIndexOf("/")));
    this.files.set(
      targetPath,
      encoding === "base64" ? new Uint8Array(Buffer.from(contents, "base64")) : new TextEncoder().encode(contents),
    );
  }

  async unlink(targetPath: string): Promise<void> {
    this.files.delete(targetPath);
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${targetPath}/`)) this.files.delete(path);
    }
    for (const path of [...this.directories]) {
      if (path === targetPath || path.startsWith(`${targetPath}/`)) this.directories.delete(path);
    }
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    const bytes = this.files.get(sourcePath);
    if (!bytes) throw new Error(`ENOENT: ${sourcePath}`);
    await this.mkdir(destinationPath.slice(0, destinationPath.lastIndexOf("/")));
    this.files.set(destinationPath, bytes);
    this.files.delete(sourcePath);
  }

  async hash(targetPath: string, algorithm: "sha256"): Promise<string> {
    assert.equal(algorithm, "sha256");
    const bytes = this.files.get(targetPath);
    if (!bytes) throw new Error(`ENOENT: ${targetPath}`);
    return createHash("sha256").update(bytes).digest("hex");
  }

  async stat(targetPath: string): Promise<ReactNativeFileStat> {
    if (this.files.has(targetPath)) {
      return { path: targetPath, name: targetPath.split("/").at(-1), size: this.files.get(targetPath)!.byteLength, isFile: () => true, isDirectory: () => false };
    }
    if (this.directories.has(targetPath)) {
      return { path: targetPath, name: targetPath.split("/").at(-1), size: 0, isFile: () => false, isDirectory: () => true };
    }
    throw new Error(`ENOENT: ${targetPath}`);
  }

  async readDir(targetPath: string): Promise<ReactNativeFileStat[]> {
    const prefix = `${targetPath.replace(/\/+$/g, "")}/`;
    const childNames = new Set<string>();
    for (const path of [...this.files.keys(), ...this.directories]) {
      if (!path.startsWith(prefix)) continue;
      const child = path.slice(prefix.length).split("/")[0];
      if (child) childNames.add(child);
    }
    return await Promise.all([...childNames].sort().map((name) => this.stat(`${prefix}${name}`)));
  }

  downloadFile(options: Parameters<ReactNativeFileSystem["downloadFile"]>[0]): ReactNativeDownloadJob {
    const jobId = this.#nextJobId++;
    this.downloads.push(options.fromUrl);
    const route = this.routes.get(options.fromUrl);
    const promise = Promise.resolve().then(async () => {
      if (!route) throw new Error(`offline: ${options.fromUrl}`);
      options.begin?.({ jobId, statusCode: route.statusCode, contentLength: route.bytes.byteLength });
      if (route.statusCode >= 200 && route.statusCode < 300) {
        await this.mkdir(options.toFile.slice(0, options.toFile.lastIndexOf("/")));
        this.files.set(options.toFile, route.bytes);
        options.progress?.({ jobId, contentLength: route.bytes.byteLength, bytesWritten: route.bytes.byteLength });
      }
      return { jobId, statusCode: route.statusCode, bytesWritten: route.bytes.byteLength };
    });
    return { jobId, promise };
  }

  stopDownload(jobId: number): void {
    this.stoppedDownloads.push(jobId);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeNpy(shape: readonly [number, number], values: readonly number[]): Uint8Array {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape[0]}, ${shape[1]}), }`;
  const padding = (16 - ((10 + header.length + 1) % 16)) % 16;
  header += `${" ".repeat(padding)}\n`;
  const output = new Uint8Array(10 + header.length + values.length * 4);
  output.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, header.length & 0xff, header.length >>> 8], 0);
  output.set(new TextEncoder().encode(header), 10);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => view.setFloat32(10 + header.length + index * 4, value, true));
  return output;
}

test("React Native base64 codec is independent of browser and Node globals", () => {
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  assert.equal(uint8ArrayToBase64(bytes), Buffer.from(bytes).toString("base64"));
  assert.deepEqual(base64ToUint8Array(uint8ArrayToBase64(bytes)), bytes);
  assert.throws(() => base64ToUint8Array("not base64"), /invalid base64/);
});

test("React Native voice archives load when Hermes has no TextDecoder global", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "TextDecoder");
  Object.defineProperty(globalThis, "TextDecoder", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  try {
    const voices = loadVoicesNpz(zipSync({ "Bella.npy": makeNpy([1, 2], [0.25, -0.5]) }));
    assert.deepEqual(voices.Bella.shape, [1, 2]);
    assert.deepEqual(voices.Bella.data, Float32Array.of(0.25, -0.5));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "TextDecoder", descriptor);
    else delete (globalThis as { TextDecoder?: typeof TextDecoder }).TextDecoder;
  }
});

test("React Native CE phonemizer runs as plain JavaScript and preserves punctuation", async () => {
  const phonemizer = await createReactNativeCePhonemizer({
    fileSystem: new MemoryReactNativeFileSystem(),
    rulesText: "",
    listText: "hello h@loU\nworld w3:ld\n",
  });
  assert.equal(await phonemizer.phonemize("hello, world!"), "həlˈoʊ, wˈɜːld! ");
  phonemizer.dispose();
  await assert.rejects(phonemizer.phonemize("hello"), /disposed/);
});

test("React Native CE phonemizer downloads, verifies, and reuses its dictionary cache", async () => {
  const fileSystem = new MemoryReactNativeFileSystem();
  const rulesUrl = "https://assets.test/en_rules";
  const listUrl = "https://assets.test/en_list";
  const rules = new TextEncoder().encode("");
  const list = new TextEncoder().encode("hello h@loU\n");
  fileSystem.routes.set(rulesUrl, { statusCode: 200, bytes: rules });
  fileSystem.routes.set(listUrl, { statusCode: 200, bytes: list });
  const options = {
    fileSystem,
    cacheDir: "/cache/phonemizer-test",
    rulesUrl,
    listUrl,
    rulesSha256: sha256(rules),
    listSha256: sha256(list),
  } as const;

  const first = await createReactNativeCePhonemizer(options);
  assert.equal(await first.phonemize("hello."), "həlˈoʊ. ");
  first.dispose();
  assert.equal(fileSystem.downloads.length, 2);

  fileSystem.routes.clear();
  const offline = await createReactNativeCePhonemizer(options);
  assert.equal(await offline.phonemize("hello"), "həlˈoʊ");
  offline.dispose();
  assert.equal(fileSystem.downloads.length, 2);

  fileSystem.files.set("/cache/phonemizer-test/en_list", new TextEncoder().encode("corrupt"));
  fileSystem.routes.set(listUrl, { statusCode: 200, bytes: list });
  const repaired = await createReactNativeCePhonemizer(options);
  repaired.dispose();
  assert.equal(fileSystem.downloads.length, 3);
});

test("React Native cache downloads, verifies, reuses, inspects, repairs, and clears assets", async () => {
  const fileSystem = new MemoryReactNativeFileSystem();
  const reference = { repoId: "KittenML/native-test", revision: "revision", fileSystem };
  const base = "https://huggingface.co/KittenML/native-test/resolve/revision/";
  const config = new TextEncoder().encode('{"type":"ONNX2","model_file":"model.onnx","voices":"voices.npz"}');
  const model = Uint8Array.from([1, 2, 3, 4]);
  const voices = Uint8Array.from([5, 6, 7]);
  fileSystem.routes.set(`${base}config.json`, { statusCode: 200, bytes: config });
  fileSystem.routes.set(`${base}model.onnx`, { statusCode: 200, bytes: model });
  fileSystem.routes.set(`${base}voices.npz`, { statusCode: 200, bytes: voices });
  const integrity = {
    "config.json": sha256(config),
    "model.onnx": sha256(model),
    "voices.npz": sha256(voices),
  };

  const first = await downloadReactNativeKittenTtsRepoAssets({ ...reference, integrity });
  assert.equal(fileSystem.downloads.length, 3);
  fileSystem.routes.clear();
  const offline = await downloadReactNativeKittenTtsRepoAssets({ ...reference, integrity });
  assert.equal(offline.modelPath, first.modelPath);
  assert.equal(fileSystem.downloads.length, 3);

  fileSystem.files.set(first.modelPath, new TextEncoder().encode("corrupt"));
  fileSystem.routes.set(`${base}model.onnx`, { statusCode: 200, bytes: model });
  await downloadReactNativeKittenTtsRepoAssets({ ...reference, integrity });
  assert.equal(fileSystem.downloads.length, 4);
  assert.deepEqual(fileSystem.files.get(first.modelPath), model);

  const info = await reactNativeKittenTtsCacheInfo(reference);
  assert.equal(info.files.length, 3);
  assert.equal(info.totalBytes, config.byteLength + model.byteLength + voices.byteLength);
  assert.equal(await clearReactNativeKittenTtsCache(reference), true);
  assert.equal((await reactNativeKittenTtsCacheInfo(reference)).exists, false);
});

test("React Native downloads propagate cancellation and stop the native job", async () => {
  const fileSystem = new MemoryReactNativeFileSystem();
  const controller = new AbortController();
  fileSystem.downloadFile = () => {
    const jobId = 91;
    queueMicrotask(() => controller.abort(new DOMException("cancelled", "AbortError")));
    return { jobId, promise: new Promise(() => {}) };
  };
  await assert.rejects(
    downloadReactNativeKittenTtsRepoAssets({
      repoId: "KittenML/cancel-test",
      revision: "revision",
      fileSystem,
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.deepEqual(fileSystem.stoppedDownloads, [91]);
  assert.equal([...fileSystem.files.keys()].some((path) => path.endsWith(".download")), false);
});

test("React Native runtime reuses the shared pipeline and native ONNX tensors", async () => {
  const fileSystem = new MemoryReactNativeFileSystem();
  const voices = zipSync({ "Bella.npy": makeNpy([2, 2], [0.1, 0.2, 0.3, 0.4]) });
  fileSystem.files.set("/voices.npz", voices);
  fileSystem.files.set("/model.onnx", Uint8Array.of(1));
  let released = 0;
  let receivedFeeds: Record<string, ReactNativeOrtTensor> | undefined;

  class Tensor implements ReactNativeOrtTensor {
    constructor(
      readonly type: "int64" | "float32",
      readonly data: BigInt64Array | Float32Array,
      readonly dimensions: readonly number[],
    ) {}
  }
  const session: ReactNativeOrtSession = {
    outputNames: ["waveform", "duration"],
    async run(feeds) {
      receivedFeeds = feeds;
      return {
        waveform: new Tensor("float32", Float32Array.from({ length: 5004 }, (_, index) => index / 5004), [1, 5004]),
        duration: { data: Int32Array.from({ length: (feeds.input_ids.data as BigInt64Array).length }, () => 1) },
      };
    },
    async release() { released += 1; },
  };
  const ortModule: ReactNativeOrtModule = {
    Tensor,
    InferenceSession: { async create(model) { assert.equal(model, "/model.onnx"); return session; } },
  };

  const runtime = await createReactNativeKittenTts({
    config: { sampleRate: 24_000 },
    modelPath: "/model.onnx",
    voicesPath: "/voices.npz",
    fileSystem,
    ortModule,
    phonemizer: { async phonemize() { return "həlˈoʊ"; } },
  });
  const result = await runtime.synthesize({ text: "Hello", voice: "Bella", cleanText: false });
  assert.equal(result.audio.length, 4);
  assert.equal(result.sampleRate, 24_000);
  assert.deepEqual(result.executionProviders, ["cpu"]);
  assert.ok(receivedFeeds?.input_ids.data instanceof BigInt64Array);
  assert.deepEqual((receivedFeeds?.style as Tensor).dimensions, [1, 2]);
  await runtime.release();
  await runtime.release();
  assert.equal(released, 1);
});

test("React Native runtime releases a created session when voice loading fails", async () => {
  const fileSystem = new MemoryReactNativeFileSystem();
  fileSystem.files.set("/voices.npz", Uint8Array.of(1, 2, 3));
  let released = 0;
  const session: ReactNativeOrtSession = {
    outputNames: ["waveform"],
    async run() { return {}; },
    async release() { released += 1; },
  };
  class Tensor implements ReactNativeOrtTensor {
    readonly data: BigInt64Array | Float32Array;
    constructor(
      _type: "int64" | "float32",
      data: BigInt64Array | Float32Array,
      _dimensions: readonly number[],
    ) {
      this.data = data;
    }
  }
  const ortModule: ReactNativeOrtModule = {
    Tensor,
    InferenceSession: { async create() { return session; } },
  };

  await assert.rejects(createReactNativeKittenTts({
    config: { sampleRate: 24_000 },
    modelPath: "/model.onnx",
    voicesPath: "/voices.npz",
    fileSystem,
    ortModule,
    phonemizer: { async phonemize() { return ""; } },
  }));
  assert.equal(released, 1);
});

test("React Native playback writes a temporary WAV and cleans it after playback", async () => {
  const fileSystem = new MemoryReactNativeFileSystem();
  let playedPath = "";
  const player = createReactNativeFileAudioPlayer({
    async playFile(filePath) {
      playedPath = filePath;
      const wav = fileSystem.files.get(filePath);
      assert.equal(new TextDecoder().decode(wav?.subarray(0, 4)), "RIFF");
    },
    async stop() {},
  }, { fileSystem });
  await player.play(Float32Array.of(0, 0.25, -0.25, 0), 24_000);
  assert.match(playedPath, /^\/cache\/kittentts-playback-/);
  assert.equal(await fileSystem.exists(playedPath), false);
  await player.dispose?.();
});

test("React Native Sound does not begin playback after stop during native loading", async () => {
  const fileSystem = new MemoryReactNativeFileSystem();
  let loaded: ((error: Error | null) => void) | undefined;
  let plays = 0;
  let stops = 0;
  let releases = 0;
  class Sound {
    constructor(_filePath: string, _basePath: string, callback: (error: Error | null) => void) {
      loaded = callback;
    }
    play(): void { plays += 1; }
    stop(): void { stops += 1; }
    release(): void { releases += 1; }
  }
  const player = createReactNativeSoundPlayer(Sound, { fileSystem });
  const playing = player.play(Float32Array.of(0, 0.25), 24_000);
  while (!loaded) await Promise.resolve();
  await player.stop?.();
  await playing;
  loaded!(null);
  await Promise.resolve();
  assert.equal(plays, 0);
  assert.equal(stops, 1);
  assert.equal(releases, 1);
});
