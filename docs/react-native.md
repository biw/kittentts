# React Native

The `@biwills/kittentts/react-native` entry runs KittenTTS inference locally on iOS and
Android. It uses ONNX Runtime's native React Native module, stores pinned model
assets in the app cache, and shares the high-level API, preprocessing,
phonemizer, model registry, results, streaming, and WAV encoder with the Node
and browser runtimes.

React Native support is a developer preview. The repository runs Release-mode
Hermes smoke tests on iOS Simulator and Android Emulator in CI. Those tests
exercise native ONNX inference, WAV encoding, asset integrity, and an offline
cache restart. They do not replace performance and memory validation on every
physical device class your application supports.

## Requirements

- React Native 0.81.x with Metro package exports enabled. The committed native
  harness pins React Native 0.81.5 and treats that version as the compatibility
  target.
- iOS 15.1 or newer
- Android API 24 or newer
- A native build with autolinked modules

Expo Go cannot load the required native modules. Expo projects must use a
development build or a prebuilt native project.

React Native 0.82 and newer are not currently supported by the pinned
`onnxruntime-react-native` 1.24.3 peer: its iOS module still depends on the
legacy `RCTCxxBridge` API removed from bridge-free React Native. Keep the React
Native and ONNX Runtime versions aligned with the tested fixture until that
upstream module supports newer React Native releases.

## Install

Bare React Native:

```bash
npm install @biwills/kittentts onnxruntime-react-native @dr.pogodin/react-native-fs
npx pod-install
```

Expo with Expo Audio playback:

```bash
npm install @biwills/kittentts onnxruntime-react-native @dr.pogodin/react-native-fs
npx expo install expo-audio expo-dev-client
npx expo prebuild
npx expo run:ios
# or: npx expo run:android
```

After installing the development build, start Metro with:

```bash
npx expo start --dev-client
```

## Generate Audio

Use the explicit subpath in native source. The package root also has a
`react-native` condition, but the subpath makes the intended runtime obvious
and avoids older resolver ambiguity.

```ts
import { KittenTTS } from "@biwills/kittentts/react-native";

const tts = await KittenTTS.create({
  model: "nano-int8",
  defaultVoice: "Bella",
  onProgress(event) {
    console.log(event.phase, event.loadedBytes, event.totalBytes);
  },
});

try {
  const result = await tts.generate("Generated entirely on this device.");
  console.log(result.durationSeconds, result.wavBase64());
} finally {
  await tts.dispose();
}
```

The first creation downloads the selected model, voices, and configuration
from a pinned KittenML Hugging Face revision. It also downloads about 264 KB of
English rules and dictionary data for the bundled Hermes-compatible
CEPhonemizer engine. Every default asset URL is revision-pinned and every file
has a pinned SHA-256 digest. Downloads go to a temporary file, are verified,
and are moved atomically into the app cache. Later sessions work from that
cache without a network request.

`nano-int8` is the smallest first-run download at about 28 MB. The other model
choices are `nano`, `micro`, and `mini`.

## Playback

Playback is deliberately optional. Pass an adapter when creating the session
to enable `speak()`.

Expo Audio:

```ts
import * as ExpoAudio from "expo-audio";
import { KittenTTS, createExpoAudioPlayer } from "@biwills/kittentts/react-native";

const tts = await KittenTTS.create({
  model: "nano-int8",
  player: createExpoAudioPlayer(ExpoAudio),
});

await tts.speak("Played through Expo Audio.");
await tts.dispose();
```

React Native Sound:

```ts
import Sound from "react-native-sound";
import { KittenTTS, createReactNativeSoundPlayer } from "@biwills/kittentts/react-native";

const tts = await KittenTTS.create({
  player: createReactNativeSoundPlayer(Sound),
});
```

The adapters encode a temporary WAV in the cache, play it, and remove it after
playback. A custom audio layer can implement `ReactNativeFilePlayer` and use
`createReactNativeFileAudioPlayer()`.

## Cancellation

Creation, asset downloads, synthesis, and playback accept `AbortSignal`.
Cancelling a download calls the native filesystem module's `stopDownload()`
and removes the partial file.

```ts
const controller = new AbortController();
const promise = KittenTTS.create({
  model: "nano-int8",
  signal: controller.signal,
});

controller.abort();
await promise;
```

## Cache Management

Cache helpers use the same repository identity as the model registry:

```ts
import {
  KITTENTTS_MODELS,
  clearReactNativeKittenTtsCache,
  reactNativeKittenTtsCacheInfo,
} from "@biwills/kittentts/react-native";

const model = KITTENTTS_MODELS["nano-int8"];
const reference = { repoId: model.repoId, revision: model.revision };

console.log(await reactNativeKittenTtsCacheInfo(reference));
await clearReactNativeKittenTtsCache(reference);
```

Set `cacheDir` on `KittenTTS.create()` and the cache helpers to use an
application-controlled location.

## Preloaded Local Assets

Applications that copy model assets into local storage can skip downloading by
passing all three resolved inputs:

```ts
const tts = await KittenTTS.create({
  model: "nano-int8",
  config: parsedConfig,
  modelPath: "/absolute/device/path/model.onnx",
  voicesPath: "/absolute/device/path/voices.npz",
  phonemizerOptions: {
    rulesPath: "/absolute/device/path/en_rules",
    listPath: "/absolute/device/path/en_list",
  },
});
```

All local paths must be real filesystem paths readable by their native modules;
Metro asset numbers and HTTP URLs are not accepted by the native ONNX session.
Copy bundled assets into an app-support or cache directory before creation.
Keep the model, voices archive, and config from the same KittenML model
revision. The default phonemizer data comes from eSpeak NG revision
`59eb19938f12e30881c81d86ce4a7de25414c9f4`.

## React Native Web

For an application that also targets React Native Web, install
`onnxruntime-web` in addition to the native peers. The browser condition is
listed before the `react-native` condition, so Metro selects the browser facade
on web:

```bash
npm install @biwills/kittentts onnxruntime-web onnxruntime-react-native @dr.pogodin/react-native-fs
```

```ts
import {
  KittenTTS,
  createBrowserAudioPlayer,
} from "@biwills/kittentts/react-native";

const tts = await KittenTTS.create({
  model: "nano-int8",
  player: createBrowserAudioPlayer(),
});
```

The web build retains browser WASM/WebGPU and worker support; native iOS and
Android use direct CPU inference.

## Native Test Harness

The committed app in `tests-native/react-native-smoke` is generated from the
React Native 0.81.5 Community template and installs the freshly packed
`@biwills/kittentts` tarball. It deliberately does not import SDK source from the
workspace.

Run the iOS fixture locally from the repository root:

The native harness needs JDK 17 for Maestro, plus Xcode/CocoaPods for iOS or
the Android SDK and emulator for Android.

```bash
pnpm install --frozen-lockfile
pnpm native:smoke:prepare
pnpm native:smoke:assets
cd tests-native/react-native-smoke
bundle install
cd ios && bundle exec pod install && cd ../../..
pnpm native:smoke:serve
```

In a second terminal, build the app in Release mode and run the Maestro flow:

```bash
cd tests-native/react-native-smoke
pnpm ios
cd ../..
export PATH="$(scripts/install_maestro.sh):$PATH"
maestro test .maestro/native-smoke.yaml
```

Use `pnpm android` instead of `pnpm ios` for a running Android emulator. The
asset server listens on port 9123; the fixture uses `127.0.0.1` from iOS
Simulator and Android's `10.0.2.2` host alias. The app clears its private test
cache, performs a cold synthesis, verifies finite non-silent 24 kHz audio and
the WAV header, then recreates the runtime against an unreachable URL. The
second synthesis must succeed without a download callback and must match the
cold-run sample count and signal RMS.

The final screen and device Documents directory include timing metrics,
`native-smoke-result.json`, and `native-smoke.wav`. CI uploads those files with
the simulator screenshot and device logs on success or failure. A separate
host-side verifier rejects missing or malformed artifacts and independently
checks the WAV header, PCM payload, signal metrics, native execution provider,
cold downloads, and download-free warm restart. The Android fixture permits
cleartext traffic only because it consumes a local test server; applications
should continue to use HTTPS for model assets. Its Release APK is also marked
debuggable solely so CI can retrieve the JSON and WAV from private app storage;
production applications must not copy that setting.

## Current Boundaries

- Native inference currently reports the CPU execution provider.
- The native CEPhonemizer and supported pronunciation target are English
  (`en-us`). Its asm.js engine is bundled; its revision-pinned English rules
  and dictionary are cached on first use.
- Model assets are not included in the npm tarball.
- MP3 encoding is available through the shared lazy encoder, but mobile
  playback adapters use WAV.
- Expo Go is unsupported because ONNX Runtime and filesystem access require
  native modules.
- React Native 0.82+ is blocked on a bridge-free release of the native ONNX
  Runtime peer; the CI contract currently pins React Native 0.81.5.
