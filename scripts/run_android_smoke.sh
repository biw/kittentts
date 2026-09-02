#!/usr/bin/env bash
# Runs the Android native smoke test against a booted emulator.
# Invoked by reactivecircus/android-emulator-runner, which executes each line
# of its `script` input separately, so the logic lives here as one bash script.
set -euo pipefail

artifacts=.context/native-artifacts/android
mkdir -p "${artifacts}"

pnpm native:smoke:serve > "${artifacts}/asset-server.log" 2>&1 &
server_pid=$!
trap 'kill "${server_pid}" 2>/dev/null || true' EXIT

for _attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:9123/manifest.json >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:9123/manifest.json >/dev/null

adb install -r tests-native/react-native-smoke/android/app/build/outputs/apk/release/app-release.apk
adb shell run-as com.kittentts.smoke true

set +e
maestro test .maestro/native-smoke.yaml 2>&1 | tee "${artifacts}/maestro.log"
smoke_status=${PIPESTATUS[0]}
set -e

adb exec-out run-as com.kittentts.smoke cat files/native-smoke-result.json \
  > "${artifacts}/native-smoke-result.json" 2>/dev/null || true
adb exec-out run-as com.kittentts.smoke cat files/native-smoke.wav \
  > "${artifacts}/native-smoke.wav" 2>/dev/null || true
adb exec-out screencap -p > "${artifacts}/final.png" || true
adb logcat -d > "${artifacts}/device.log" || true

if [[ "${smoke_status}" -ne 0 ]]; then
  exit "${smoke_status}"
fi

pnpm exec tsx scripts/verify_react_native_smoke_artifacts.ts \
  android \
  "${artifacts}/native-smoke-result.json" \
  "${artifacts}/native-smoke.wav"
