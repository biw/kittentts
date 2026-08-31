# TypeScript Migration Plan

This document records the completed staged migration. The TypeScript runtime is
now the production implementation; the isolated Python project under
`reference/python` remains only as an independent fixture oracle.

## Target split

Use three packages or modules:

- `core`: shared text preprocessing, phoneme normalization, token building, fixture loading, and parity tests.
- `node`: model loading, cache management, `onnxruntime-node`, file I/O, and Node-specific phonemizer integration.
- `web`: model loading over `fetch`, `onnxruntime-web`, worker wiring, and browser-specific asset handling.

The boundary between them should look like this:

1. `cleanText(text) -> cleanedText`
2. `phonemize(cleanedText) -> phonemeText`
3. `buildInputs(phonemeText, voice, speed) -> { inputIds, style, speed }`
4. `runModel(feeds) -> audio`
5. `encodeAudio(audio) -> wav/blob/file`

## What counts as parity

Parity should be defined per stage.

- Text preprocessing parity: exact string match.
- Phonemizer parity: exact phoneme string match after an explicitly-defined whitespace normalization step.
- Token/input parity: exact integer-array match for `input_ids`, exact `ref_id`, and exact float-array match for `style`.
- Audio parity: same sample count plus a numerical tolerance, not byte-identical WAV files.

Audio should not be treated as a byte-for-byte contract across runtimes. Different ONNX runtimes and execution providers may produce valid outputs that are numerically close but not identical at the byte level.

In this repo's current Python reference implementation, repeated inference of the same chunk is not sample-deterministic, so raw waveform equality is not a reliable automated test even before the JavaScript port exists.

Recommended audio checks:

- sample count within a model-specific number of 600-sample output frames
- aggregate metrics such as `min`, `max`, `mean`, `std`, and `rms` within tight tolerances
- optional spectrogram or mel-distance comparisons for deeper regressions
- listenable spot checks from committed or generated WAV files

## Port order

1. Generate reference fixtures from Python.
2. Run the ONNX model in Node from precomputed feeds.
3. Run the ONNX model in the browser from precomputed feeds.
4. Port token building and style selection to shared TypeScript.
5. Port text preprocessing to shared TypeScript.
6. Port or replace the phonemizer in Node.
7. Port or replace the phonemizer in the browser.
8. Optimize loading, caching, and bundle size.

This order keeps failures local:

- If step 2 fails, the problem is Node runtime or model loading.
- If step 3 fails, the problem is browser runtime or browser asset loading.
- If step 4 or 5 fails, the problem is shared TypeScript logic.
- If step 6 or 7 fails, the problem is phonemizer compatibility.

## Initial scope

Keep the first milestone intentionally narrow.

- Model: `KittenML/kitten-tts-nano-0.8`
- Node target: Node 24 on Linux, macOS, and Windows
- Browser target: Chrome first
- Output: PCM float arrays plus WAV files for spot checks
- Long text: keep the existing chunking behavior

Do not start with the int8 browser path. Prove correctness first.

## Current verification

The migration is implemented. `pnpm test` is the single release gate and exposes each former one-off verification phase as a named Vitest test. Reusable assertions and isolated consumer drivers live under `tests-js`; the remaining files under `scripts/` are fixture generators, listening-sample generation, or the local static harness.

Reference fixture generation:

- `.venv/bin/python reference/python/tools/generate_audio_fixtures.py`

Browser runtime check:

- `pnpm serve:browser-harness`
- Open `http://127.0.0.1:4173/web/fixture-check.html?pipeline=fixture`
- Open `http://127.0.0.1:4173/web/fixture-check.html?pipeline=phonemizer-js`
- Open `http://127.0.0.1:4173/web/fixture-check.html?pipeline=full-js`
- Open `http://127.0.0.1:4173/web/fixture-check.html?pipeline=full-js&transport=worker`
- For deterministic debugging or headless verification, add `&execution=wasm`
- Expect the page status chip to become `pass` and the JSON block to show metric deltas inside tolerance

Package build:

- `pnpm build`
- `pnpm fixtures:bootstrap`
- `pnpm test`
- `pnpm samples:generate` for listenable WAV artifacts covering the reference corpus

Node example:

- `node examples/node-synthesize.mjs "Kitten TTS from Node." Bruno .context/examples/node-example.wav`
- `node examples/node-synthesize.mjs --repo KittenML/kitten-tts-nano-0.8 "Kitten TTS from Hugging Face." Bruno .context/examples/node-repo-example.wav`

Browser example:

- `pnpm serve:browser-harness`
- Open `http://127.0.0.1:4173/examples/browser-basic.html`
- For the simplest smoke-test path, open `http://127.0.0.1:4173/examples/browser-basic.html?autorun=1&execution=wasm`
- To exercise repo-backed loading, add `?repo=KittenML/kitten-tts-nano-0.8`
- To exercise the exported worker path, add `?transport=worker`
- Automated direct, worker, WASM, WebGPU, and packed-browser checks run through `pnpm test`.

## Browser constraints

`onnxruntime-node` is the native Node binding. It does not require WebAssembly for model execution.

`onnxruntime-web` runs the same ONNX model with browser execution providers. In practice that means:

- `wasm` for CPU execution
- `webgpu` when available for GPU execution

For the browser implementation, treat `webgpu` as an optimization and `wasm` as the required fallback.

### Safari support

Safari 26.5 and newer is a required target. CI exercises main-thread and worker
execution with WASM. Hardware-backed main-thread and worker WebGPU are exercised
by `pnpm test:safari:webgpu`; GitHub's virtualized macOS runner has no GPU
adapter. Single-threaded WASM remains the portable default; multithreaded WASM
retains the cross-origin isolation requirements below.

### Cross-origin isolation

Multithreaded WebAssembly relies on `SharedArrayBuffer`, which in modern browsers generally requires cross-origin isolation. That usually means serving the app with:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

The tradeoff is operational, not algorithmic. Cross-origin isolation can restrict how freely the page embeds or loads third-party scripts, iframes, fonts, or other assets that do not send compatible CORS or CORP headers.

If the app controls its own assets and can avoid brittle third-party embeds, this is usually manageable.

## Phonemizer fallback

The phonemizer should be an interface with multiple implementations. That keeps the runtime plan flexible even if one candidate is not good enough.

Examples:

- `phonemizeWithReferenceEngine`
- `phonemizeWithJsPackage`
- `phonemizeWithBrowserWasm`

That does not mean all of them ship in production. It means parity can be debugged without rewriting the rest of the pipeline.

## Current phonemizer result

The current Node/browser candidate is the npm `phonemizer` package. Its raw output is close to the Python reference, but not identical:

- it returns one phoneme string per punctuation-delimited phrase instead of one preserved-punctuation string
- it drops punctuation by default
- on the current fixture corpus, it differs on a small `/oːɹ/` vs `/ɔːɹ/` vowel set

The shared adapter now reconstructs preserved punctuation and applies a narrow compatibility normalization so the fixture corpus matches exactly before input IDs are built.

The browser fixture harness now supports three modes:

- `pipeline=fixture`: replay saved `input_ids`, `style`, and `speed`
- `pipeline=phonemizer-js`: rebuild phonemes and `input_ids` in the browser, then reuse saved `style` and `speed`
- `pipeline=full-js`: rebuild cleaned text, chunking, phonemes, `input_ids`, style, and speed in the browser from the raw fixture case text

That keeps the browser boundaries explicit:

- if `phonemizer-js` fails while `fixture` passes, the problem is browser phonemization or token building
- if `full-js` fails while `phonemizer-js` passes, the problem is browser preprocessing, chunking, or voice/style selection

The browser runtime now also exists behind a worker boundary:

- `/web/browser-runtime.mjs`: reusable browser API for `create()` and `synthesize()`
- `/web/browser-worker.mjs`: worker entrypoint for inference off the main thread
- `/web/browser-worker-client.mjs`: thin client wrapper around the worker protocol

The package-facing browser build now emits real distributable modules:

- `dist/browser/index.js`: exports the browser runtime and worker client
- `dist/browser/worker.js`: worker entrypoint for module-worker usage
- `dist/audio/index.js`: shared WAV encoder
- package exports: `./browser` and `./browser/worker`

The package metadata is now complete enough for `npm pack --dry-run`, and the package verifier checks that the built tarball includes the expected runtime files, type declarations, README, and license.

The reference manifest is now committed at `fixtures/reference-manifest.json` and pins the exact Hugging Face snapshot revision used for parity. `pnpm fixtures:bootstrap` materializes `.context/reference-fixtures` from that manifest plus downloaded `model.onnx` and `voices.npz`, so the fixture-backed verifiers no longer depend on a pre-existing local `.context` directory.

GitHub Actions now runs the JS package verification flow from a fresh checkout in `.github/workflows/ci.yml`. Packed Node consumers are additionally exercised on Node 24 across Linux, macOS, and Windows.

That means the browser path is no longer only a fixture harness. The harness still exists for parity checking, but the shared TypeScript browser runtime can now be built and imported as a package surface.

The browser runtime now accepts both an `ortModuleLoader` override and serializable `ortModuleUrls`. The URL-based form matters for workers: the worker init payload can point ONNX Runtime at explicit browser module URLs without passing a function through `postMessage`.

The package worker entry is now bundled so `fflate` and `phonemizer` do not depend on browser import-map resolution at worker startup. ONNX Runtime remains configurable separately through `ortModuleUrls`.

The package-facing Node build now also emits real distributable modules:

- `dist/node/index.js`: exports the Node runtime
- `dist/audio/index.js`: shared WAV encoder
- package exports: `./node` and `./audio`

The public runtime surface is no longer fixture-manifest-only. Both runtimes now accept:

- explicit model asset location (`modelPath` or `modelUrl`)
- explicit voices asset location (`voicesPath` or `voicesUrl`)
- a small runtime config object with `sampleRate`, `speedPriors`, and `voiceAliases`

If those are provided, the runtime can initialize without loading `.context/reference-fixtures/manifest.json`.

They also now support direct repo-backed initialization:

- `repoId`
- optional `revision`
- optional `repoBaseUrl`
- optional `configFilename`

On Node, that path downloads and caches `config.json`, the ONNX model, and `voices.npz`. In browser code, it resolves the same `config.json` contract into fetchable asset URLs.

The Node verifier for that runtime enforces:

- exact cleaned text and chunk-count parity for every fixture case
- exact chunk feed parity for every fixture chunk
- bounded sample-count parity for every synthesized chunk and full case
- corpus-wide audio-stat tolerances for every fixture chunk
- temporal-envelope and zero-crossing signatures for every fixture chunk

The fixture generator records full-case audio and per-chunk audio from separate inference passes, and the current model is not sample-deterministic across repeated runs. The checks therefore use measured tolerances rather than waveform equality while still failing corpus-wide numerical and temporal regressions.

The fixture page can exercise that path with `transport=worker`. If `pipeline=full-js&transport=worker` fails while `pipeline=full-js` passes, the problem is in worker lifecycle, message transfer, or browser worker asset loading rather than the synthesis pipeline itself.

Current verification note:

- the old `--dump-dom` browser automation path still is not a reliable way to validate module-worker fetch behavior
- the current CDP-backed verifier covers the public browser example in both `transport=main` and `transport=worker`, including the repo-backed asset path
