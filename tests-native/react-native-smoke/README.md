# KittenTTS React Native smoke app

This is a committed React Native 0.81.5 Community CLI fixture for real iOS and
Android testing. It installs exact native dependencies and consumes the npm
tarball created by `scripts/prepare_react_native_smoke.mjs`, not workspace
source.

The Maestro flow in `.maestro/native-smoke.yaml` drives a cold native synthesis,
checks the generated signal and WAV container, then proves that a second runtime
works from verified cache while its asset origin is unreachable. See
`docs/react-native.md` for local commands and CI artifact details.

Do not add this package to the root pnpm workspace: isolation is intentional so
the fixture catches missing package files, conditional exports, and peer setup.
