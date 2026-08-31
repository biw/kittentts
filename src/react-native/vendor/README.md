# CEPhonemizer runtime

`cephonemizer-runtime.cjs` is the asm.js build of the Apache-2.0
CEPhonemizer engine published in `@kittentts/react-native@1.2.0` by KittenML.
It is generated from the C++ sources in
[`KittenML/KittenTTS-react-native`](https://github.com/KittenML/KittenTTS-react-native)
with that repository's `scripts/build-cephonemizer.js` script.

The vendored build is intentionally plain JavaScript (`WASM=0`) so Metro can
include it without a WebAssembly asset loader and Hermes can execute it without
browser stream/decompression globals.

Upstream npm tarball integrity:

```text
@kittentts/react-native@1.2.0
sha512-LXMQ5VKx5LUYxcGmsmVgi2LYtjxZ0e2hn9IA2ibD9Q7CYcOZ3Vw9ac+Rorh2L55mp4B5MbrQ5oSIFFIjEtIjtA==
```

When updating it, rebuild from the upstream Apache-2.0 C++ source, replace the
generated file, run the native phonemizer parity test, and update this record.
