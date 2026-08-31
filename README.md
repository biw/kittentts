# KittenTTS

Isomorphic text-to-speech for Node.js, browsers, and React Native. One TypeScript API, backed by ONNX Runtime, with no Python, eSpeak, or system codecs required to install or run.

`@biwills/kittentts` is designed to match the upstream
[KittenML/KittenTTS](https://github.com/KittenML/KittenTTS) Python
implementation, verified against its output, but universal: Node, browser, and
React Native share one package and one API instead of a separate library per
platform.

```ts
import { KittenTTS } from "@biwills/kittentts";

const tts = await KittenTTS.create({ model: "nano" });
const result = await tts.generate("KittenTTS runs without Python.", { voice: "Bella" });
await writeFile("speech.wav", result.wavData());
await tts.dispose();
```

## Highlights

- **One API, every JavaScript target.** Node 24 native inference, browser WASM
  and WebGPU, Web Workers, and native iOS and Android.
- **Four models.** `nano`, `nano-int8`, `micro`, and `mini`, downloaded lazily
  from pinned Hugging Face revisions and verified against SHA-256 digests.
- **Streaming.** Demand-driven chunks with backpressure and `AbortSignal`
  cancellation.
- **Audio output.** WAV, base64 WAV, lazy MP3, token timings, and playback
  adapters for Web Audio, Expo Audio, and React Native Sound.
- **Durable caches.** Atomic, integrity-checked model caches that recover from
  corruption and work fully offline once warm.
- **Zero production dependencies.** Platform runtimes are optional peers, so
  each app installs only what it needs.

## Install

Pick the runtime for your target. All three are optional peers.

```bash
# Node.js 24+
npm install @biwills/kittentts onnxruntime-node

# Browsers
npm install @biwills/kittentts onnxruntime-web

# React Native (bare or Expo development build)
npm install @biwills/kittentts onnxruntime-react-native @dr.pogodin/react-native-fs
```

Expo Go is not supported because ONNX Runtime and the filesystem module are native. See the [React Native guide](docs/react-native.md) for Expo setup, playback, cancellation, caching, and preloaded assets.

The package is ESM-only and targets ES2022. CommonJS callers must use dynamic `import()`.

## Usage

### Node.js

```ts
import { writeFile } from "node:fs/promises";
import { KittenTTS } from "@biwills/kittentts";

const tts = await KittenTTS.create({
  model: "nano",
  defaultVoice: "Bella",
});

try {
  const result = await tts.generate("Hello from Node.");
  console.log(result.durationSeconds, result.sampleRate);
  await writeFile("hello.wav", result.wavData());
} finally {
  await tts.dispose();
}
```

### Browser

The browser build defaults to a module worker and to `executionMode: "auto"`, which prefers WebGPU and falls back to WASM.

```ts
import { KittenTTS } from "@biwills/kittentts";

const tts = await KittenTTS.create({
  model: "nano-int8",
  onProgress: (event) => console.log(event.phase, event.progress),
});

await tts.speak("Hello from the browser."); // call from a user gesture
```

Pass `transport: "direct"` for main-thread inference, or `executionMode: "webgpu"` to fail fast when WebGPU is unavailable. Check `tts.capabilities()` for the provider, thread count, and cross-origin isolation actually in use.

### React Native

```ts
import * as ExpoAudio from "expo-audio";
import { KittenTTS, createExpoAudioPlayer } from "@biwills/kittentts/react-native";

const tts = await KittenTTS.create({
  model: "nano-int8",
  player: createExpoAudioPlayer(ExpoAudio),
});

await tts.speak("Hello from this device.");
await tts.dispose();
```

### Streaming

```ts
const controller = new AbortController();

for await (const chunk of tts.generateStream(longDocument, {
  voice: "Bruno",
  signal: controller.signal,
})) {
  play(chunk.result.audio, chunk.result.sampleRate);
  if (chunk.isLast) break;
}
```

Each `next()` synthesizes exactly one text chunk, so consumers control the pace and nothing queues unbounded. `collectKittenTtsStream()` joins a stream into a single result with optional crossfade.

The [JavaScript SDK guide](docs/javascript-sdk.md) covers MP3 output, token timings, progress events, cache controls, worker and ONNX module URLs, and the lower-level entrypoints.

## Models

| Model | Parameters | Precision | First download |
| --- | ---: | --- | ---: |
| `nano` | 15M | fp32 | ~60 MB |
| `nano-int8` | 15M | int8 | ~28 MB |
| `micro` | 40M | fp32 | ~45 MB |
| `mini` | 80M | fp32 | ~82 MB |

Sizes include the shared voice archive. Assets come from pinned [KittenML](https://huggingface.co/KittenML) Hugging Face revisions and are not embedded in the npm tarball. Bundled voices include Bella, Bruno, Hugo, Jasper, Kiki, Leo, Luna, and Rosie.

The phonemizer targets `en-us`. Non-English and malformed input is handled safely and deterministically, but pronunciation accuracy outside English is not a supported claim.

## Platform Support

| Runtime | Direct | Worker | WASM | WebGPU | Verified in CI |
| --- | --- | --- | --- | --- | --- |
| Node.js 24 | Yes | N/A | N/A | N/A | Linux, macOS, Windows |
| Chrome (current) | Yes | Yes | Yes | Yes | Yes |
| Firefox (current) | Yes | Yes | Yes | Not claimed | Yes |
| Safari 26.5+ | Yes | Yes | Yes | Yes | WASM in CI, WebGPU on hardware |
| React Native 0.81.x, iOS 15.1+ | Yes | N/A | N/A | N/A | Release simulator smoke |
| React Native 0.81.x, Android API 24+ | Yes | N/A | N/A | N/A | Release emulator smoke |
| React Native Web | Yes | Yes | Yes | Browser-dependent | Browser CI |

Browser WASM runs on one thread unless the page is cross-origin isolated with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

React Native 0.82 and newer are blocked on a bridge-free release of the pinned
`onnxruntime-react-native` peer. CI runs real native inference in Release-mode
Hermes apps on iOS Simulator and Android Emulator. Performance and memory on
specific physical devices remain application-level validation.

## Package Entrypoints

| Import | Purpose |
| --- | --- |
| `@biwills/kittentts` | High-level facade, resolved per platform through package conditions |
| `@biwills/kittentts/node` | Node runtime and cache controls |
| `@biwills/kittentts/browser` | Browser runtime, playback, and worker client |
| `@biwills/kittentts/browser/worker` | Standalone worker entrypoint |
| `@biwills/kittentts/react-native` | Native runtime, cache controls, and playback adapters (browser facade under React Native Web) |
| `@biwills/kittentts/audio` | WAV encoding and audio joining |
| `@biwills/kittentts/audio/mp3` | Lazy MP3 encoder |

## Relationship to KittenML

This is an independent TypeScript SDK that consumes KittenML's published ONNX
models and reproduces the behavior of the Python reference: the same
preprocessing, phonemization, chunking, and audio output, checked in CI against
a Python-generated golden corpus. It is a separate package from, and does not
depend on, these upstream projects:

- [KittenML/KittenTTS](https://github.com/KittenML/KittenTTS), the Python
  reference implementation used for parity fixtures
- [KittenML/KittenTTS-web](https://github.com/KittenML/KittenTTS-web),
  published as `@kittentts/web`
- [KittenML/KittenTTS-react-native](https://github.com/KittenML/KittenTTS-react-native),
  published as `@kittentts/react-native`

## License

Apache-2.0. Model repositories have their own terms and are not redistributed by this package.
