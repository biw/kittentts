# JavaScript SDK

## Runtime Contract

`@biwills/kittentts` is Python-free at install time and runtime. Node 24 uses `onnxruntime-node`; browser builds use `onnxruntime-web`. Conditional exports select the correct implementation:

```bash
# Node 24+
npm install @biwills/kittentts onnxruntime-node

# Browser bundlers
npm install @biwills/kittentts onnxruntime-web
```

The two ONNX runtimes are optional peers. Install only the runtime for the target environment; the smaller shared runtime dependencies are bundled.

```ts
import { KittenTTS } from "@biwills/kittentts";

const tts = await KittenTTS.create({ model: "nano" });
const result = await tts.generate("Kitten TTS runs without Python.", {
  voice: "Bella",
  speed: 1,
});

await writeFile("speech.wav", result.wavData());
await tts.dispose();
```

Supported model IDs are `nano`, `nano-int8`, `micro`, and `mini`. Each maps to a pinned Hugging Face revision and SHA-256-verified model and voice archive.

## Browser

Browser transport defaults to a module worker. Pass `transport: "direct"` only when main-thread inference is intentional.

```ts
const tts = await KittenTTS.create({
  model: "nano-int8",
  transport: "worker",
  executionMode: "auto",
  onProgress(event) {
    console.log(event.phase, event.progress);
  },
});
```

`executionMode: "auto"` tries WebGPU and falls back to WASM. `executionMode: "webgpu"` requires WebGPU and fails clearly if no adapter exists. `executionMode: "wasm"` is the compatibility path. `capabilities()` reports the provider, transport, thread count, cross-origin isolation, and actual execution mode.

Workers require serializable configuration. Use `ortModuleUrls` rather than `ortModuleLoader`, and normal URLs rather than a custom `fetchImpl`.

## Streaming

`generateStream()` returns a demand-driven async iterator. It preprocesses the full input once, synthesizes one deterministic text chunk per `next()` call, and honors `AbortSignal`. This provides backpressure without an internal unbounded queue.

```ts
import { collectKittenTtsStream } from "@biwills/kittentts";

const controller = new AbortController();
const stream = tts.generateStream(longText, { signal: controller.signal });
for await (const chunk of stream) {
  consume(chunk.result.audio);
}

const complete = await collectKittenTtsStream(
  tts.generateStream(longText),
  { crossfadeMs: 10 },
);
```

## Audio And Timings

Results expose `audio`, `durationSeconds`, model-derived `tokenTimings`, `wavData()`, `wavBase64()`, and lazy `mp3Data()`. Browser `speak()` uses Web Audio and must be called from a user gesture when the browser's autoplay policy requires it.

## Cache And Network

Node stores assets under the platform cache directory using atomic writes. Browser builds use Cache API when available. Both validate SHA-256 before reuse, evict corrupt entries, retry transient responses, and support cancellation. Node warm-cache startup is fully offline, including `config.json`.

Use `nodeKittenTtsCacheInfo` / `clearNodeKittenTtsCache` on Node and `browserAssetCacheInfo` / `clearBrowserAssetCache` in browsers. Set `forceDownload` to bypass an existing entry.

For multi-threaded browser WASM, serve COOP `same-origin` and COEP `require-corp`; without cross-origin isolation the runtime safely uses one thread. The supplied harness also demonstrates a CSP with `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self' https: data:`, and no inline scripts. `data:` is needed only by the optional MP3 encoder's embedded WASM fetch.

## Browser Support

Chrome main-thread WASM, worker WASM, and WebGPU run in CI. Firefox main-thread and worker WASM run in CI. Safari main-thread and worker WASM run in CI. Safari WebGPU is covered by `pnpm test:safari:webgpu` on hardware-backed macOS because GitHub's virtualized macOS runner exposes no GPU adapter. Local Safari verification is opt-in because WebDriver opens an isolated automation window and requires Safari's **Allow Remote Automation** setting.

## Verification

`pnpm test` is the single Vitest release gate. It covers TypeScript and `tsdown`, unit and failure paths, the 13-case real-audio Python corpus, the 35-case text oracle corpus, deterministic fuzz and large-input behavior, all four pinned models, Node inference, browser WASM/worker/WebGPU, strict CSP, packed Node/browser consumers, executable examples, security audits, package/type linting, npm publish dry-run, and download/package size budgets. Hosted CI additionally requires Firefox and opt-in Safari WebDriver suites.

Python is used only to create committed independent reference fixtures. The isolated `reference/python` project enables intentional fixture regeneration; Python is not invoked by any JavaScript build, package install, test consumer, or runtime path.
