# Contributing

## Prerequisites

- Node.js 24
- Corepack with the pinned pnpm version from `package.json`
- Python only when intentionally regenerating reference fixtures

## Development Loop

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

Tests are the release contract. Add behavior assertions to Vitest rather than
adding standalone verification scripts. Reusable integration logic belongs in
`tests-js/verification` or `tests-js/helpers`.

## Runtime Changes

- Preserve the conditional Node, browser, and React Native exports.
- Do not bundle any ONNX runtime or native filesystem module into the package.
- Keep model revisions and integrity hashes explicit.
- Add failure-path tests for network, cache, worker, and lifecycle changes.
- Update package and model budgets intentionally, with an explanation.

## Text Changes

Text preprocessing must remain deterministic and bounded for untrusted input.
Add exact cases to `fixtures/text-parity-corpus.json`, regenerate
`fixtures/text-parity.json` with the Python oracle, and add independent
robustness properties when behavior intentionally diverges from Python.

```bash
.venv/bin/python reference/python/tools/generate_text_parity_fixtures.py
```

## Python Fixtures

Python is an independent oracle, not a runtime dependency. See
`reference/python/README.md` before regenerating audio fixtures. Do not accept a
large fixture diff without reviewing preprocessing, chunk boundaries, waveform
metrics, and generated listening samples.

## Browser Tests

Chrome tests are headless. Firefox runs through geckodriver in CI. Safari tests
require **Allow Remote Automation** and are opt-in locally because Safari opens
an isolated automation window. On macOS, the test harness restores the
previously focused application so Safari can continue in the background. The
WebGPU suite additionally requires a real GPU adapter, which GitHub's
virtualized macOS runner does not provide:

```bash
pnpm test:safari
pnpm test:safari:webgpu
```

## React Native Tests

`pnpm test:react-native` covers the native adapters with deterministic test
doubles. Changes to the React Native runtime must also pass the packed-package
Release app in `tests-native/react-native-smoke` on iOS Simulator and Android
Emulator. The harness performs real native ONNX inference and verifies its
offline restart; setup and local commands are documented in
`docs/react-native.md`. Keep the app's React Native and native peer versions
exact so CI upgrades are deliberate and reviewable.

## Pull Requests

Keep changes scoped, explain compatibility or budget changes, and include the
exact verification commands run. Do not commit `.context`, downloaded models,
generated audio, package tarballs, or credentials.

